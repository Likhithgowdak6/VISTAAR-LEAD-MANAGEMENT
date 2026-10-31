import { useRef, useState } from 'react';

import { uploadCallRecording } from '../../api/endpoints';
import { useAuth } from '../../auth/AuthContext';
import { type AuthValue, errorMessage } from '../types';

/**
 * Attaching a recording the agent's own phone made.
 *
 * THE CONSENT TICK IS THE POINT OF THIS COMPONENT, not the file picker. The server refuses an
 * upload without it, and it is asked EVERY TIME rather than once per account, because consent
 * attaches to a particular conversation with a particular customer - not to a setting somebody
 * agreed to months ago on a different call.
 *
 * IT IS A PRODUCT CONTROL, NOT LEGAL ADVICE, and the wording says so. A tick box inside a CRM
 * does not by itself discharge an obligation under Indian law; it records that the agent says
 * the participants were told, and puts that claim in front of them at the moment it matters.
 *
 * NOTHING IS DISCOVERED. The agent chooses a file. Vistaar does not scan device storage, hold
 * All Files Access, or hunt for an OEM recording folder - Android does not permit recording the
 * call itself, and this app does not go looking for what the phone recorded either.
 */

type Props = {
  callId: string;
  onUploaded: () => void;
};

const RecordingUploader = ({ callId, onUploaded }: Props) => {
  const { authedRequest } = useAuth() as AuthValue;
  const inputRef = useRef<HTMLInputElement>(null);

  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);

    try {
      await authedRequest((token) =>
        uploadCallRecording({
          token,
          callId,
          file,
          fileName: file.name,
          consentAcknowledged: true,
        }),
      );

      onUploaded();
    } catch (uploadError: unknown) {
      setError(errorMessage(uploadError, 'That recording could not be uploaded.'));
    } finally {
      setBusy(false);
      // Cleared so choosing the SAME file again still fires a change event - otherwise a
      // retry after a failure looks like the button is dead.
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Attach a recording
      </p>
      {/* The panel above has already explained WHY there is no recording; repeating it here
          would be noise. This says what to do about it. */}
      <p className="mt-1 text-[11px] text-slate-500">
        If your phone recorded this call, you can attach the file.
      </p>

      <label className="mt-2 flex items-start gap-2 text-[11px] text-slate-600">
        <input
          type="checkbox"
          aria-label="Confirm everyone on the call was told it was being recorded"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          Everyone on this call was told it was being recorded. Check your own legal obligations —
          this tick box isn’t legal advice.
        </span>
      </label>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        aria-label="Recording file"
        // Disabled until consent is given, so the picker cannot even be opened first. The
        // server enforces the same rule; this just makes the order obvious.
        disabled={!consent || busy}
        onChange={(event) => {
          const file = event.target.files?.[0];

          if (file) {
            void handleFile(file);
          }
        }}
        className="mt-2 block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-[11px] file:font-medium disabled:opacity-50"
      />

      {busy ? <p className="mt-1 text-[11px] text-slate-500">Uploading…</p> : null}

      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default RecordingUploader;
