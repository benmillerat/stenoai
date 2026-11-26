'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { validateMeetingStem } = require('./speaker-ipc');

const CONTENT_TYPES = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff', flac: 'audio/flac',
  ogg: 'audio/ogg', caf: 'audio/x-caf', mp4: 'video/mp4', mov: 'video/quicktime',
};

function mediaStem(value) {
  validateMeetingStem(value);
  // Colons also address NTFS alternate data streams on Windows.
  if ((process.platform === 'win32' && value.includes(':')) || /\p{Cc}/u.test(value)) {
    throw new TypeError('Invalid meeting identifier.');
  }
  return value;
}

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

function createSpeakerMediaProtocol({ getRecordingsDir, extensions }) {
  async function sameDirectory(recording) {
    const current = await fs.lstat(recording.directory, { bigint: true });
    return current.isDirectory() && !current.isSymbolicLink()
      && current.dev === recording.directoryStatus.dev && current.ino === recording.directoryStatus.ino
      && await fs.realpath(recording.directory) === recording.realDirectory;
  }

  async function resolveRecording(stem) {
    mediaStem(stem);
    const directory = getRecordingsDir();
    const directoryStatus = await fs.lstat(directory, { bigint: true });
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) return null;
    const realDirectory = await fs.realpath(directory);
    const directoryIdentity = { directory, directoryStatus, realDirectory };
    const names = (await fs.readdir(realDirectory))
      .filter(name => path.parse(name).name === stem
        && extensions.includes(path.extname(name).slice(1).toLowerCase()))
      .sort();
    const wav = `${stem}.wav`;
    // Probe the WAV path itself, matching Python on case-insensitive volumes.
    const candidates = extensions.includes('wav') ? [wav, ...names.filter(name => name !== wav)] : names;
    for (const name of candidates) {
      const filename = path.join(realDirectory, name);
      const status = await fs.lstat(filename, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!status) continue;
      if (!status.isFile() || status.isSymbolicLink()) continue;
      if (path.dirname(await fs.realpath(filename)) !== realDirectory) continue;
      if (!await sameDirectory(directoryIdentity)) return null;
      return { ...directoryIdentity, filename, status, extension: path.extname(name).slice(1).toLowerCase() };
    }
    return null;
  }

  async function getRecordingMedia(stem) {
    try {
      const recording = await resolveRecording(stem);
      if (recording) return {
        success: true,
        url: `steno-media://recording/${encodeURIComponent(stem)}`,
        is_video: ['mp4', 'mov'].includes(recording.extension),
      };
    } catch { /* Do not expose local paths in IPC errors. */ }
    return { success: false, error: 'Recording unavailable.' };
  }

  async function handle(request) {
    let file;
    try {
      // Accept one encoded stem, never a renderer-supplied filesystem path.
      const match = /^steno-media:\/\/recording\/([^/?#]+)$/.exec(request.url);
      if (!match) return new Response(null, { status: 404 });
      const recording = await resolveRecording(decodeURIComponent(match[1]));
      if (!recording) return new Response(null, { status: 404 });
      file = await fs.open(recording.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const status = await file.stat({ bigint: true });
      if (!status.isFile() || status.dev !== recording.status.dev || status.ino !== recording.status.ino
        || !await sameDirectory(recording)) {
        return new Response(null, { status: 404 });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      const headers = {
        'Accept-Ranges': 'bytes',
        'Content-Type': CONTENT_TYPES[recording.extension],
        'Content-Length': String(status.size),
      };
      const size = Number(status.size);
      if (!Number.isSafeInteger(size)) return new Response(null, { status: 404 });
      const rangeHeader = request.method === 'GET' ? request.headers.get('Range') : null;
      const range = rangeHeader === null ? null : byteRange(rangeHeader, size);
      if (rangeHeader !== null && !range) return new Response(null, {
        status: 416, headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${status.size}` },
      });
      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${status.size}`;
        headers['Content-Length'] = String(range.end - range.start + 1);
      }
      let body = null;
      if (request.method !== 'HEAD' && size) {
        body = Readable.toWeb(file.createReadStream(range || {}));
        file = null; // The stream owns the open handle, including on cancellation.
      }
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    } finally {
      if (file) await file.close();
    }
  }

  return { getRecordingMedia, handle };
}

module.exports = { createSpeakerMediaProtocol };
