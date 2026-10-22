import { type ChangeEvent, type FormEvent, useRef, useState } from 'react';

import { type UploadedMedia } from '../api/endpoints';
import { formatFileSize } from '../lib/format';
import { type MessageTemplate } from '../types';
import VoiceRecorder from './composer/VoiceRecorder';
import { errorMessage, type SendableAccount } from './types';

/**
 * What the file pickers will offer. Deliberately narrower than "any file": it matches the
 * server's allowlist, so the owner finds out a .heic will not send while they are still in the
 * file dialog rather than after a 4 MB upload.
 */
const PHOTO_VIDEO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/3gpp,video/webm';
const DOCUMENT_ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv';

/** Mirrors MEDIA_MAX_UPLOAD_BYTES. Checked here only to fail fast; the server decides. */
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

const ATTACH_MENU_ITEM_CLASS =
  'flex min-h-11 w-full items-center px-3 text-left text-sm text-bone-dim transition-colors hover:bg-key/10 hover:text-key';

type StagedAttachment = {
  blob: Blob;
  fileName: string;
  kind: 'file' | 'voice';
  sizeBytes: number;
  /** Object URL for the thumbnail, when the staged file is an image. Revoked on removal. */
  previewUrl: string | null;
};

const generateIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

type SendArgs = {
  body: string;
  idempotencyKey: string;
  whatsappAccountId: string | null;
  /** Present only when an attachment was staged and uploaded first. */
  media?: UploadedMedia | null;
};

type Props = {
  onSend: (args: SendArgs) => Promise<void>;
  /**
   * Stores the bytes and returns the key the send will carry. Absent means this deployment or
   * this user cannot send attachments, and the attachment button is not rendered at all.
   */
  onUploadMedia?: (args: {
    blob: Blob;
    fileName: string;
    kind: 'file' | 'voice';
  }) => Promise<UploadedMedia>;
  /**
   * Opens the template writer for the open thread. Replaced "Suggest reply", which filled this
   * box with a single AI draft; the writer offers several versions, each editable and sendable
   * on its own, and lives in a dialog so it does not crowd the composer on a phone.
   */
  onOpenTemplates?: () => void;
  canUseTemplates?: boolean;
  /** Numbers with a live session that this user may send from. */
  sendableAccounts?: readonly SendableAccount[];
  /** The number the thread is currently on, pre-selected in the dropdown. */
  currentAccountId?: string | null;
  currentAccountName?: string | null;
  /**
   * Saved price messages, loaded by the parent. Picking one fills the box rather than sending it:
   * a quote goes out under the studio's name, so it gets the same human look as an AI draft.
   */
  templates?: readonly MessageTemplate[];
};

const MessageComposer = ({
  onSend,
  onUploadMedia,
  onOpenTemplates,
  canUseTemplates = false,
  sendableAccounts = [],
  currentAccountId = null,
  currentAccountName = null,
  templates = [],
}: Props) => {
  const [body, setBody] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);

  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * A ref, not the `sending` state. Two clicks land in the same React batch and both read the
   * old state - the template writer learned this the hard way, with three clicks producing two
   * sends. An attachment makes it worse: the duplicate is a second upload as well.
   */
  const submittingRef = useRef(false);

  const clearAttachment = () => {
    setAttachment((current) => {
      if (current?.previewUrl) {
        URL.revokeObjectURL(current.previewUrl);
      }

      return null;
    });
  };

  const stageAttachment = (blob: Blob, fileName: string, kind: 'file' | 'voice') => {
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      setError(`That file is too large. The limit is ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`);
      return;
    }

    setError(null);
    clearAttachment();
    setAttachment({
      blob,
      fileName,
      kind,
      sizeBytes: blob.size,
      previewUrl: blob.type.startsWith('image/') ? URL.createObjectURL(blob) : null,
    });
  };

  /**
   * Closes the menu and opens the chosen source. The ref reads live in here, in an event
   * handler, rather than in objects built during render - a ref read on the render path is
   * both a lint error and a real hazard, because what it points at is not settled yet.
   */
  const chooseAttachmentSource = (source: 'photo' | 'document' | 'voice') => {
    setAttachMenuOpen(false);

    if (source === 'photo') {
      photoInputRef.current?.click();
      return;
    }

    if (source === 'document') {
      documentInputRef.current?.click();
      return;
    }

    setRecorderOpen(true);
  };

  const handleFilePicked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    // Reset first: picking the same file twice in a row fires no change event otherwise, which
    // makes "remove, then re-add the same photo" silently do nothing.
    event.target.value = '';

    if (file) {
      stageAttachment(file, file.name, 'file');
    }
  };

  const handleBodyChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value);
  };

  /**
   * Loads a saved quote into the box for editing, never straight out to the customer.
   *
   * Confirms before overwriting: a half-typed reply is work, and there is no undo on a textarea.
   */
  const handleTemplate = (templateId: string) => {
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) {
      return;
    }

    if (body.trim() !== '' && !window.confirm('Replace what you have typed with this template?')) {
      return;
    }

    setBody(template.body);
  };

  // Falls back to the thread's own number until the agent picks something else, so a stale
  // selection can never survive switching to a different lead.
  const activeAccountId = selectedAccountId ?? currentAccountId ?? null;

  // The thread's own number may not be sendable — disconnected, or outside this user's access.
  // It still gets an entry, disabled, so the dropdown never silently displays a different
  // number than the one the message would actually go out on.
  const currentIsSendable = sendableAccounts.some((account) => account.id === currentAccountId);
  const accountOptions = [
    ...(currentAccountId && !currentIsSendable
      ? [{ id: currentAccountId, name: currentAccountName ?? 'Current number', disabled: true }]
      : []),
    ...sendableAccounts.map((account) => ({ ...account, disabled: false })),
  ];

  const showAccountPicker = accountOptions.length > 1;
  const isSwitchingAccount =
    activeAccountId !== null && currentAccountId !== null && activeAccountId !== currentAccountId;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = body.trim();

    // An attachment can travel with no caption; text alone still has to be text.
    if ((!trimmed && !attachment) || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setSending(true);
    setError(null);

    try {
      // THE UPLOAD IS PART OF THE SEND, and happens first: a message row that pointed at bytes
      // which never arrived would be queued, claimed, and fail at the socket. One idempotency
      // key covers the whole action, so a retry after a failed upload is a fresh attempt rather
      // than a duplicate message.
      let media: UploadedMedia | null = null;

      if (attachment) {
        if (!onUploadMedia) {
          throw new Error('Attachments are not available here.');
        }

        media = await onUploadMedia({
          blob: attachment.blob,
          fileName: attachment.fileName,
          kind: attachment.kind,
        });
      }

      await onSend({
        body: trimmed,
        idempotencyKey: generateIdempotencyKey(),
        whatsappAccountId: activeAccountId,
        media,
      });

      setBody('');
      clearAttachment();
    } catch (sendError: unknown) {
      // The staged attachment is deliberately kept: the owner should be able to retry without
      // finding the file again.
      setError(errorMessage(sendError, 'Unable to send message.'));
    } finally {
      submittingRef.current = false;
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Send a message"
      // The bottom inset ADDS to p-3 so the send button clears the gesture bar; shrink-0 stops
      // the composer being squeezed to nothing when the thread above it is long.
      className="shrink-0 border-t border-slate-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
    >
      {error ? (
        <p role="alert" className="mb-2 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {canUseTemplates || showAccountPicker || templates.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {templates.length > 0 ? (
              /* Resets to the placeholder after each pick, so choosing the same template twice in
                 a row still fires a change event. */
              <select
                aria-label="Insert a template"
                value=""
                onChange={(event) => handleTemplate(event.target.value)}
                disabled={sending}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">Template…</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.title}
                  </option>
                ))}
              </select>
            ) : null}
            {canUseTemplates && onOpenTemplates ? (
              <button
                type="button"
                onClick={onOpenTemplates}
                disabled={sending}
                className="rounded-lg border border-blue-300 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ✨ Message templates
              </button>
            ) : null}
            {showAccountPicker ? (
              <label className="flex items-center gap-1.5 text-xs text-slate-500">
                <span>From</span>
                <select
                  aria-label="Send from"
                  value={activeAccountId ?? ''}
                  onChange={(event) => setSelectedAccountId(event.target.value || null)}
                  disabled={sending}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                >
                  {accountOptions.map((account) => (
                    <option key={account.id} value={account.id} disabled={account.disabled}>
                      {account.disabled ? `${account.name} (not connected)` : account.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {isSwitchingAccount ? (
              <span className="text-xs text-amber-600">
                This lead will move to the selected number.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {/* STAGED, NOT SENT. Shown above the input so it is between the thread and the words
          being typed - the order the message will actually arrive in. */}
      {attachment ? (
        <div
          data-testid="staged-attachment"
          className="mb-2 flex items-center gap-2 rounded-lg border border-hairline bg-panel p-2"
        >
          {attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt=""
              className="h-10 w-10 shrink-0 rounded object-cover"
            />
          ) : (
            <span aria-hidden="true" className="text-lg leading-none">
              {attachment.kind === 'voice' ? '🎤' : '📎'}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-bone-dim">
            {attachment.fileName}
            <span className="ml-1 text-muted">· {formatFileSize(attachment.sizeBytes)}</span>
          </span>
          <button
            type="button"
            onClick={clearAttachment}
            disabled={sending}
            aria-label="Remove attachment"
            className="min-h-11 min-w-11 rounded-lg px-2 text-xs font-medium text-bone-dim hover:text-danger disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ) : null}

      {recorderOpen ? (
        <div className="mb-2">
          <VoiceRecorder
            disabled={sending}
            onCancel={() => setRecorderOpen(false)}
            onComplete={({ blob, mimeType }) => {
              // Named for the owner's benefit only - the server renames a voice note to match
              // the container it converts to.
              const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
              stageAttachment(blob, `voice-note.${extension}`, 'voice');
              setRecorderOpen(false);
            }}
          />
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        {onUploadMedia ? (
          <div className="relative shrink-0">
            {/* Two inputs rather than one: `accept` is what makes a phone offer the camera roll
                for photos and the file browser for documents, and it cannot be both at once. */}
            <input
              ref={photoInputRef}
              type="file"
              accept={PHOTO_VIDEO_ACCEPT}
              onChange={handleFilePicked}
              className="hidden"
              data-testid="photo-input"
              aria-hidden="true"
              tabIndex={-1}
            />
            <input
              ref={documentInputRef}
              type="file"
              accept={DOCUMENT_ACCEPT}
              onChange={handleFilePicked}
              className="hidden"
              data-testid="document-input"
              aria-hidden="true"
              tabIndex={-1}
            />

            <button
              type="button"
              onClick={() => setAttachMenuOpen((open) => !open)}
              disabled={sending}
              aria-label="Add attachment"
              aria-expanded={attachMenuOpen}
              aria-haspopup="menu"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-hairline text-lg text-bone-dim transition-colors hover:border-key/40 hover:text-key disabled:opacity-50"
            >
              <span aria-hidden="true">＋</span>
            </button>

            {attachMenuOpen ? (
              <>
                {/* A click anywhere else closes the menu. Rendered behind it, covering the
                    viewport, because a `blur` handler on the button fires before the menu's own
                    click lands and would swallow the choice. */}
                <button
                  type="button"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={() => setAttachMenuOpen(false)}
                  className="fixed inset-0 z-10 cursor-default"
                />
                <div
                  role="menu"
                  aria-label="Attachment type"
                  className="absolute bottom-full left-0 z-20 mb-2 w-44 overflow-hidden rounded-lg border border-hairline bg-panel shadow-xl"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => chooseAttachmentSource('photo')}
                    className={ATTACH_MENU_ITEM_CLASS}
                  >
                    📷 Photo or video
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => chooseAttachmentSource('document')}
                    className={ATTACH_MENU_ITEM_CLASS}
                  >
                    📎 Document
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => chooseAttachmentSource('voice')}
                    className={ATTACH_MENU_ITEM_CLASS}
                  >
                    🎤 Voice message
                  </button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <textarea
          aria-label="Message"
          rows={1}
          value={body}
          onChange={handleBodyChange}
          placeholder="Type a reply…"
          className="max-h-32 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || (body.trim() === '' && !attachment)}
          className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
        >
          {sending ? (attachment ? 'Uploading…' : 'Sending…') : 'Send'}
        </button>
      </div>
    </form>
  );
};

export default MessageComposer;
