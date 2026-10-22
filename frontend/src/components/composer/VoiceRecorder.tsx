import { useEffect, useRef, useState } from 'react';

/**
 * Recording a voice note in the browser.
 *
 * THE FORMAT IS NOT OURS TO CHOOSE, QUITE. Chrome's MediaRecorder will not produce Ogg/Opus -
 * only WebM/Opus - and WhatsApp plays voice notes as Ogg. Firefox does produce Ogg. So this
 * asks for Ogg first and accepts WebM, and the server converts whatever arrives (see the
 * backend's media/voice-note.ts). The preference below is not cosmetic: when the browser can
 * give us Ogg directly, nothing has to be transcoded server-side at all.
 *
 * THE STREAM IS ALWAYS STOPPED. Every exit from this component - send, cancel, unmount, an
 * error - runs `releaseStream`. A MediaStream left open keeps the browser's recording indicator
 * lit and the microphone held, which is alarming and looks like spyware.
 */
const PREFERRED_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/webm;codecs=opus',
  'audio/webm',
];

const MAX_SECONDS = 300;

const pickMimeType = (): string | undefined => {
  if (typeof MediaRecorder === 'undefined') {
    return undefined;
  }

  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
};

const formatDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);

  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

type Props = {
  /** Hands over the finished recording. The parent uploads and sends it. */
  onComplete: (recording: { blob: Blob; mimeType: string; seconds: number }) => void;
  onCancel: () => void;
  disabled?: boolean;
};

const VoiceRecorder = ({ onComplete, onCancel, disabled = false }: Props) => {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ blob: Blob; url: string; mimeType: string } | null>(
    null,
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewUrlRef = useRef<string | null>(null);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  // Unmount can happen mid-recording - the owner switches lead, or closes the thread. Both the
  // microphone and the preview URL have to go with it.
  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }

      releaseStream();

      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!recording) {
      return;
    }

    const timer = setInterval(() => {
      setSeconds((value) => {
        // A recording left running by accident is a 50 MB upload nobody meant to make.
        if (value + 1 >= MAX_SECONDS) {
          recorderRef.current?.stop();
        }

        return value + 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [recording]);

  const start = async () => {
    setError(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record audio.');
      return;
    }

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Denied, or no microphone. Both read the same to the owner and neither is recoverable
      // from in here - the permission lives in the browser's own UI.
      setError('Microphone permission is needed to record a voice note.');
      return;
    }

    const mimeType = pickMimeType();

    let recorder: MediaRecorder;

    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setError('This browser cannot record audio.');
      return;
    }

    chunksRef.current = [];
    streamRef.current = stream;
    recorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      releaseStream();
      setRecording(false);

      // `recorder.mimeType` rather than the requested one: the browser decides, and the server
      // validates what actually arrives against the bytes.
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });

      chunksRef.current = [];

      if (blob.size === 0) {
        setError('Nothing was recorded.');
        return;
      }

      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreview({ blob, url, mimeType: type });
    };

    setSeconds(0);
    setRecording(true);
    recorder.start();
  };

  const stop = () => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
    }
  };

  const discard = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setPreview(null);
    setSeconds(0);
    setError(null);
  };

  const cancel = () => {
    stop();
    discard();
    releaseStream();
    onCancel();
  };

  const send = () => {
    if (!preview) {
      return;
    }

    onComplete({ blob: preview.blob, mimeType: preview.mimeType, seconds });
    // The parent owns the blob now; the URL was only ever for the preview player.
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setPreview(null);
    setSeconds(0);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-panel p-2"
      role="group"
      aria-label="Voice message"
    >
      {error ? (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      ) : null}

      {preview ? (
        <>
          <audio src={preview.url} controls className="h-9 min-w-0 flex-1" aria-label="Playback" />
          <button
            type="button"
            onClick={discard}
            className="min-h-11 rounded-lg border border-hairline px-3 text-xs font-medium text-bone-dim hover:border-danger/50 hover:text-danger"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={send}
            disabled={disabled}
            className="min-h-11 rounded-lg bg-key px-4 text-xs font-semibold text-ink disabled:opacity-50"
          >
            Send
          </button>
        </>
      ) : (
        <>
          <span
            aria-live="polite"
            className="font-mono text-xs tabular-nums text-bone-dim"
            data-testid="recorder-clock"
          >
            {recording ? `● ${formatDuration(seconds)}` : 'Ready'}
          </span>
          {recording ? (
            <button
              type="button"
              onClick={stop}
              className="min-h-11 rounded-lg bg-key px-4 text-xs font-semibold text-ink"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={disabled}
              className="min-h-11 rounded-lg border border-key/40 px-4 text-xs font-semibold text-key disabled:opacity-50"
            >
              Record
            </button>
          )}
          <button
            type="button"
            onClick={cancel}
            className="ml-auto min-h-11 rounded-lg border border-hairline px-3 text-xs font-medium text-bone-dim hover:text-bone"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
};

export default VoiceRecorder;
