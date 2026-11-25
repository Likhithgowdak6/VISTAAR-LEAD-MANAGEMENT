import { type ConversationChannel } from '../types';

/**
 * Which surface a thread arrived on.
 *
 * SHOWN ONLY FOR INSTAGRAM, deliberately. Almost every thread in this CRM is WhatsApp, so a
 * "WhatsApp" badge on all of them would be noise that makes the Instagram ones harder to spot —
 * which is the opposite of the point. The absence of a badge means WhatsApp, and that reads
 * correctly because it is also what every historical thread is.
 *
 * It matters that staff can tell at a glance: the reply box behaves differently (Instagram has a
 * hard 24-hour window with no template to reopen it), and so does the customer's expectation of
 * who they are talking to.
 */
const ChannelBadge = ({ channel }: { channel?: ConversationChannel | null }) => {
  if (channel !== 'instagram') {
    return null;
  }

  return (
    <span
      className="rounded-full bg-fuchsia-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-700 dark:bg-fuchsia-500/10 dark:text-fuchsia-300"
      title="This conversation arrived as an Instagram DM"
    >
      Instagram
    </span>
  );
};

export default ChannelBadge;
