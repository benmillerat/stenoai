import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpeakerVideoDialog } from './SpeakerVideoDialog';

// jsdom has no media pipeline: play/pause/load are stubbed, and time is driven
// by setting currentTime and firing `timeupdate` by hand, as a real <video>
// would while playing.
let paused = true;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  paused = true;
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {
    paused = false;
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
    paused = true;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(() => paused);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(props: Partial<React.ComponentProps<typeof SpeakerVideoDialog>> = {}) {
  const onClose = vi.fn();
  const onError = vi.fn();
  render(
    <SpeakerVideoDialog
      url="steno-media://recording/mtg"
      start={10}
      end={20}
      onClose={onClose}
      onError={onError}
      {...props}
    />,
  );
  const video = screen.getByTestId('speaker-video') as HTMLVideoElement;
  const tick = (seconds: number) => {
    video.currentTime = seconds;
    fireEvent.timeUpdate(video);
  };
  return { video, tick, onClose, onError };
}

describe('SpeakerVideoDialog', () => {
  it('opens the whole file at the excerpt start and plays', () => {
    const { video } = setup();
    expect(video.getAttribute('src')).toBe('steno-media://recording/mtg');
    expect(video.currentTime).toBe(10);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.hasAttribute('controls')).toBe(false);
  });

  it('pauses once at the excerpt end, then Play runs on past it', () => {
    const { tick } = setup();
    tick(15);
    expect(pause).not.toHaveBeenCalled();
    tick(20.1);
    expect(pause).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(play).toHaveBeenCalledTimes(2);
    tick(25);
    tick(40);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('scrubbing before the end cancels the auto-pause', () => {
    const { video, tick } = setup();
    fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), {
      target: { value: '12' },
    });
    expect(video.currentTime).toBe(12);
    tick(21);
    expect(pause).not.toHaveBeenCalled();
  });

  it('Stop closes the dialog', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Stop and close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape asks to close', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('releases the stream on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <SpeakerVideoDialog url="steno-media://recording/mtg" start={1} end={2} onClose={onClose} onError={vi.fn()} />,
    );
    const video = screen.getByTestId('speaker-video') as HTMLVideoElement;
    unmount();
    expect(pause).toHaveBeenCalled();
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('reports a load or decode failure', () => {
    const { video, onError } = setup();
    fireEvent.error(video);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
