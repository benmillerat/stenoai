import * as React from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

/** Seconds -> "MM:SS" / "H:MM:SS", matching the [MM:SS] markers in the
 * saved transcript (src.transcriber._format_timestamp) so an excerpt's
 * timestamp can be found by eye in the transcript above. */
export function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

interface SpeakerVideoDialogProps {
  /** The whole recording (`steno-media://...`), seekable. */
  url: string;
  /** The excerpt: playback starts at `start` and pauses once at `end`. */
  start: number;
  end: number;
  onClose: () => void;
  /** The video could not be loaded or decoded. */
  onError: () => void;
}

/** The whole meeting video, opened at one excerpt, so a person can SEE who
 * is talking -- and scrub to wherever a name caption appears. Custom controls
 * instead of the native ones so the player reads as part of Steno. */
export function SpeakerVideoDialog({ url, start, end, onClose, onError }: SpeakerVideoDialogProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  // Cleared after the one auto-pause, or as soon as the user scrubs: from then
  // on the user drives playback.
  const pauseAtRef = React.useRef<number | null>(end);
  const [playing, setPlaying] = React.useState(false);
  const [time, setTime] = React.useState(start);
  const [duration, setDuration] = React.useState<number | null>(null);

  // The <video> sits in the dialog's portal, which mounts a render after this
  // component, so the source is attached when the element itself arrives.
  // The cleanup releases the stream on close (and on StrictMode's re-mount).
  const attachVideo = React.useCallback(
    (video: HTMLVideoElement | null) => {
      videoRef.current = video;
      if (!video) return;
      video.src = url;
      video.currentTime = start;
      // A real load failure arrives as the `error` event; a rejected play()
      // alone just leaves the player paused for the user to start.
      video.play()?.catch(() => {});
      return () => {
        videoRef.current = null;
        video.pause();
        video.removeAttribute('src');
        video.load();
      };
    },
    [url, start],
  );

  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setTime(video.currentTime);
    // shortcut: timeupdate fires every ~250 ms, so the pause can land up to a
    // quarter second past `end`; use requestVideoFrameCallback if that matters.
    if (pauseAtRef.current !== null && video.currentTime >= pauseAtRef.current) {
      pauseAtRef.current = null;
      video.pause();
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play()?.catch(() => {});
    else video.pause();
  };

  const scrub = (event: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    pauseAtRef.current = null;
    video.currentTime = Number(event.target.value);
    setTime(video.currentTime);
  };

  const max = duration ?? Math.max(end, time);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl gap-3 p-4" data-testid="speaker-video-dialog">
        <div className="flex flex-col gap-0.5 pr-8">
          <DialogTitle className="text-base font-sans font-medium">
            {t('speakerVideo.title')}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {t('speakerVideo.description', { time: formatOffset(start) })}
          </DialogDescription>
        </div>
        <video
          ref={attachVideo}
          className="aspect-video w-full rounded-lg"
          style={{ background: 'var(--ink-900)' }}
          playsInline
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onDurationChange={(event) => {
            const d = event.currentTarget.duration;
            setDuration(Number.isFinite(d) ? d : null);
          }}
          onError={onError}
          data-testid="speaker-video"
        />
        <div className="flex items-center gap-1.5">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={playing ? t('speakerVideo.pause') : t('speakerVideo.play')}
            title={playing ? t('speakerVideo.pause') : t('speakerVideo.play')}
            onClick={togglePlay}
            data-testid="speaker-video-toggle"
          >
            {playing ? <Pause className="size-[15px]" /> : <Play className="size-[15px]" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t('speakerVideo.stop')}
            title={t('speakerVideo.stop')}
            onClick={onClose}
            data-testid="speaker-video-stop"
          >
            <Square className="size-[13px]" />
          </Button>
          <input
            type="range"
            min={0}
            max={max}
            step="any"
            value={Math.min(time, max)}
            onChange={scrub}
            aria-label={t('speakerVideo.position')}
            aria-valuetext={formatOffset(time)}
            className="h-1 flex-1 cursor-pointer"
            style={{ accentColor: 'var(--fg-1)' }}
            data-testid="speaker-video-scrub"
          />
          <span
            className="shrink-0 pl-1 text-[11.5px] tabular-nums"
            style={{ color: 'var(--fg-2)' }}
            data-testid="speaker-video-time"
          >
            {`${formatOffset(time)} / ${duration === null ? '--:--' : formatOffset(duration)}`}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
