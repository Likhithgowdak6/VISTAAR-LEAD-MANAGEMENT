/**
 * How a media message is described to a human when there is nothing to show them.
 *
 * Nothing is downloaded on the inbound path, so a photo, a voice note or a PDF has no thumbnail
 * and no text - it would otherwise be a blank row in the conversation list and a blank line in
 * the owner's alert. One shared vocabulary here keeps the inbox preview and the owner-facing
 * escalation saying the same words about the same message.
 */
import { MESSAGE_TYPES, type MessageType } from '../../constants/message-types.js';

export const MEDIA_MESSAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [MESSAGE_TYPES.IMAGE]: '📷 Photo',
  [MESSAGE_TYPES.VIDEO]: '🎥 Video',
  [MESSAGE_TYPES.AUDIO]: '🎵 Audio',
  [MESSAGE_TYPES.DOCUMENT]: '📎 Document',
  [MESSAGE_TYPES.STICKER]: '🌟 Sticker',
  [MESSAGE_TYPES.CONTACT]: '👤 Contact',
  [MESSAGE_TYPES.LOCATION]: '📍 Location',
  [MESSAGE_TYPES.UNSUPPORTED]: '📄 Attachment',
});

export const VOICE_NOTE_LABEL = '🎤 Voice note';

export interface DescribeMediaMessageParams {
  type?: MessageType | null;
  /** Set for an `audio` message WhatsApp marked push-to-talk - a recorded voice note. */
  isVoiceNote?: boolean;
}

/**
 * A short human label for a non-text message ("📷 Photo", "🎤 Voice note"), or null for a plain
 * text message, which needs no label because it already carries its own words.
 */
export const describeMediaMessage = ({
  type,
  isVoiceNote,
}: DescribeMediaMessageParams = {}): string | null => {
  if (!type || type === MESSAGE_TYPES.TEXT) {
    return null;
  }

  if (type === MESSAGE_TYPES.AUDIO && isVoiceNote) {
    return VOICE_NOTE_LABEL;
  }

  return MEDIA_MESSAGE_LABELS[type] ?? MEDIA_MESSAGE_LABELS[MESSAGE_TYPES.UNSUPPORTED]!;
};
