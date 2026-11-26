'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSpeakerMediaProtocol } = require('./speaker-media-protocol');
const { registerSpeakerIpc } = require('./speaker-ipc');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'steno-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const recordings = path.join(root, 'recordings');
  await fs.mkdir(recordings);
  const media = createSpeakerMediaProtocol({
    getRecordingsDir: () => recordings,
    extensions: ['wav', 'mp4', 'mov', 'm4a'],
  });
  const request = (stem, headers = {}, method = 'GET') => media.handle({
    url: `steno-media://recording/${stem}`, method, headers: new Headers(headers),
  });
  return { root, recordings, media, request };
}

test('serves the exact whole recording, encodes stems, and prefers the backend WAV order', async (t) => {
  const { recordings, media, request } = await fixture(t);
  const stem = process.platform === 'win32' ? 'team #1 👩‍💻' : 'team: #1 👩‍💻';
  await fs.writeFile(path.join(recordings, `${stem}.mp4`), 'video bytes');
  const info = await media.getRecordingMedia(stem);
  assert.deepEqual(info, {
    success: true, url: `steno-media://recording/${encodeURIComponent(stem)}`, is_video: true,
  });
  const response = await media.handle(new Request(info.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.equal(response.headers.get('Content-Length'), '11');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(await response.text(), 'video bytes');
  await fs.writeFile(path.join(recordings, `${stem}.mov`), 'mov');
  assert.equal((await media.getRecordingMedia(stem)).is_video, true);
  assert.equal(await (await request(encodeURIComponent(stem))).text(), 'mov');
  await fs.writeFile(path.join(recordings, `${stem}.wav`), 'pcm');
  assert.equal((await media.getRecordingMedia(stem)).is_video, false);
  assert.equal(await (await request(encodeURIComponent(stem))).text(), 'pcm');
});

test('Range returns 206, exact byte slices, MIME, length and Content-Range', async (t) => {
  const { recordings, request } = await fixture(t);
  const bytes = Buffer.from('0123456789');
  await fs.writeFile(path.join(recordings, 'meeting.mov'), bytes);
  for (const [range, start, end] of [
    ['bytes=2-5', 2, 5], ['bytes=7-', 7, 9], ['bytes=-3', 7, 9],
    ['bytes=8-99', 8, 9], ['bytes=-99', 0, 9], ['bytes=0-0', 0, 0],
  ]) {
    const response = await request('meeting', { Range: range });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/10`);
    assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(response.headers.get('Content-Type'), 'video/quicktime');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'garbage']) {
    const response = await request('meeting', { Range: range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
  const head = await request('meeting', { Range: 'bytes=1-2' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal(await head.text(), '');
  assert.equal((await request('meeting', {}, 'POST')).status, 405);
});

test('WAV preference follows the filesystem case sensitivity, like the backend', async (t) => {
  const { recordings, media, request } = await fixture(t);
  await fs.writeFile(path.join(recordings, 'meeting.WAV'), 'pcm');
  await fs.writeFile(path.join(recordings, 'meeting.MP4'), 'video');
  const wavExists = await fs.access(path.join(recordings, 'meeting.wav')).then(() => true, () => false);
  assert.equal((await media.getRecordingMedia('meeting')).is_video, !wavExists);
  assert.equal(await (await request('meeting')).text(), wavExists ? 'pcm' : 'video');
});

test('empty files and cancelled streams close cleanly', async (t) => {
  const { recordings, request } = await fixture(t);
  await fs.writeFile(path.join(recordings, 'empty.wav'), '');
  const empty = await request('empty');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('Content-Length'), '0');
  assert.equal(await empty.text(), '');
  assert.equal((await request('empty', { Range: 'bytes=0-' })).status, 416);
  await fs.writeFile(path.join(recordings, 'large.mp4'), Buffer.alloc(256 * 1024));
  const response = await request('large');
  await response.body.cancel();
});

test('rejects traversal, paths, unknown stems, symlink escapes, directories and non-media', async (t) => {
  const { root, recordings, media, request } = await fixture(t);
  await fs.writeFile(path.join(root, 'private.mp4'), 'private');
  await fs.writeFile(path.join(recordings, 'note.txt'), 'private');
  await fs.mkdir(path.join(recordings, 'directory.mp4'));
  await fs.symlink(path.join(root, 'private.mp4'), path.join(recordings, 'escape.mp4'), 'file');
  for (const stem of [
    '..', '.', '%2e%2e', '/absolute', '%2Fabsolute', 'folder/meeting',
    'folder%2Fmeeting', 'folder%5Cmeeting', 'C%3Aprivate', '%00', '%1f', '%ZZ',
    'unknown', 'escape', 'note', 'directory', 'meeting?query', 'meeting#fragment',
  ]) {
    assert.equal((await request(stem)).status, 404, stem);
  }
  assert.equal((await media.getRecordingMedia('unknown')).success, false);
  assert.equal((await media.getRecordingMedia('C:private')).success, false);
});

test('uses the current recordings directory and rejects a symlinked recordings directory', async (t) => {
  const { root, recordings } = await fixture(t);
  const custom = path.join(root, 'custom-recordings');
  await fs.mkdir(custom);
  await fs.writeFile(path.join(custom, 'meeting.mp4'), 'custom');
  let active = recordings;
  const media = createSpeakerMediaProtocol({ getRecordingsDir: () => active, extensions: ['mp4'] });
  assert.equal((await media.getRecordingMedia('meeting')).success, false);
  active = custom;
  assert.equal((await media.getRecordingMedia('meeting')).is_video, true);
  const link = path.join(root, 'linked-recordings');
  await fs.symlink(custom, link, 'dir');
  active = link;
  const response = await media.handle(new Request('steno-media://recording/meeting'));
  assert.equal(response.status, 404);
});

test('rejects a recordings directory replaced with a symlink during resolution', async (t) => {
  const { root, recordings, request } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.mp4'), 'private');
  const realpath = fs.realpath;
  let swapped = false;
  t.mock.method(fs, 'realpath', async filename => {
    if (filename === recordings && !swapped) {
      swapped = true;
      await fs.rename(recordings, path.join(root, 'original-recordings'));
      await fs.symlink(outside, recordings, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return realpath(filename);
  });
  assert.equal((await request('private')).status, 404);
  assert.equal(swapped, true);
});

test('speaker IPC returns the media contract for mp4, mov, wav, and missing recordings', async (t) => {
  const { recordings, media } = await fixture(t);
  const handlers = {};
  registerSpeakerIpc({
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    getRecordingMedia: media.getRecordingMedia,
  });
  const call = stem => handlers['get-speaker-recording-media']({}, stem);
  for (const [extension, video] of [['mp4', true], ['mov', true], ['wav', false]]) {
    await fs.writeFile(path.join(recordings, `${extension}.${extension}`), extension);
    assert.deepEqual(await call(extension), {
      success: true, url: `steno-media://recording/${extension}`, is_video: video,
    });
  }
  assert.equal((await call('missing')).success, false);
  assert.equal((await call('../private')).success, false);
});

test('main wiring honors persisted custom storage before startup cache, with test isolation taking precedence', async () => {
  const main = await fs.readFile(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf('const speakerMedia = createSpeakerMediaProtocol(');
  assert.ok(start >= 0);
  const wiring = main.slice(start, main.indexOf('registerSpeakerIpc(', start));
  const env = {};
  let custom = path.resolve('custom-storage');
  let configReads = 0;
  const media = vm.runInNewContext(`${wiring}\nspeakerMedia`, {
    createSpeakerMediaProtocol: options => options,
    path, process: { env }, IMPORT_AUDIO_EXTENSIONS: ['wav'],
    getUserDataDir: () => path.resolve('default-data'),
    configJsonPath: () => 'config.json',
    readConfigFile: () => { configReads++; return { storage_path: custom }; },
  });
  assert.equal(media.getRecordingsDir(), path.join(custom, 'recordings'));
  env.STENOAI_USER_DATA_DIR = path.resolve('isolated-data');
  assert.equal(media.getRecordingsDir(), path.join(env.STENOAI_USER_DATA_DIR, 'recordings'));
  assert.equal(configReads, 1);
  delete env.STENOAI_USER_DATA_DIR;
  custom = '';
  assert.equal(media.getRecordingsDir(), path.resolve('default-data', 'recordings'));
});
