import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { useIsMobileViewport } from '../../hooks/useMobileBackLayer';
import MobileDisclosure from '../mobile/MobileDisclosure';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, type ConversationSummary } from '../types';
import ActivitySection from './ActivitySection';
import AiAutomationSection from './AiAutomationSection';
import AssignmentControl from './AssignmentControl';
import DeleteChatSection from './DeleteChatSection';
import EventDateSection from './EventDateSection';
import FollowUpsSection from './FollowUpsSection';
import LeadFormSection from './LeadFormSection';
import LeadScoreSection from './LeadScoreSection';
import NotesSection from './NotesSection';
import RevealPhone from './RevealPhone';
import ServiceSection from './ServiceSection';
import StageControl from './StageControl';
import TagsSection from './TagsSection';

type Props = {
  conversation: ConversationSummary;
  contactId?: string | null;
  onStageChange?: (stage: string) => void;
  /** Bubbles up so the inbox can drop the now-hidden thread from its selection. */
  onDeleted?: () => void;
  /**
   * Returns to the messages. Rendered only below xl, which is exactly the range where this
   * panel replaces the thread instead of sitting beside it - and where, until this existed,
   * opening Details hid the only control that could close it again.
   */
  onClose?: () => void;
  /** Named in the mobile header, so the panel says which lead it belongs to. */
  leadName?: string | null;
};

const LeadPanel = ({
  conversation,
  contactId,
  onStageChange,
  onDeleted,
  onClose,
  leadName,
}: Props) => {
  const { permissions } = useAuth() as AuthValue;
  // Below xl this panel is the whole screen; above it, a reference column beside the thread.
  const mobile = useIsMobileViewport();
  const canAssign = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_ASSIGN);
  const canDelete = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_DELETE);

  // Bumping this key re-fetches the activity timeline after a mutating action.
  const [activityKey, setActivityKey] = useState(0);
  const bumpActivity = () => setActivityKey((value) => value + 1);

  const handleStageChange = (stage: string) => {
    onStageChange?.(stage);
    bumpActivity();
  };

  // Full width below xl, where it replaces the thread rather than sitting beside it.
  return (
    <aside
      aria-label="Lead details"
      className="flex h-full w-full shrink-0 flex-col overflow-y-auto overscroll-contain border-l border-slate-200 bg-white xl:w-80"
    >
      {/* xl:hidden, because above xl the thread is still on screen with its own Hide details
          button and a second back control would be noise. Sticky so a long panel can be closed
          without scrolling back to the top of it.

          THE TOP INSET IS NOT OPTIONAL. With `viewport-fit=cover` the page paints under the
          status bar, and when this panel is open it IS the whole screen - the thread and its
          app bar are hidden behind it, so this header is the topmost thing drawn. Without the
          inset it sits under the clock, taking the one control that returns to the messages
          with it. Every other full-screen surface gets this through `.m-appbar`; this header
          is hand-rolled because it is a white panel, not the ink masthead. */}
      {onClose ? (
        <header className="sticky top-0 z-10 -mb-1 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] xl:hidden">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to messages"
            className="-ml-1 flex min-h-11 min-w-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-700 active:bg-slate-100"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ←
            </span>
            Messages
          </button>
          {/* The screen's heading, not decoration. When this panel is open on a phone it is the
              whole screen: the thread and the inbox are both behind `display: none`, so their
              headings are out of the accessibility tree and without this one the screen has no
              heading at all. Only rendered below xl - above it the thread's own h2 is still on
              screen and this header does not exist. */}
          {leadName ? (
            <h1 className="min-w-0 truncate text-sm font-semibold text-slate-900">{leadName}</h1>
          ) : null}
        </header>
      ) : null}

      {/* THE SAME THIRTEEN SECTIONS, GROUPED ON A PHONE.
          Desktop keeps the flat column - it is a reference panel beside the thread, and
          collapsing it there would add a click to something already visible. On a phone this
          IS the screen, about two thousand pixels of it, so the four things reached for while
          talking to someone stay open at the top and the rest fold away. Nothing is removed
          and no section is rendered differently inside its group. */}
      {mobile ? (
        <div className="flex flex-col gap-3 p-3">
          {/* Open: who they are and what to send them. */}
          <div className="flex flex-col gap-5 rounded-[var(--m-radius-card)] border border-hairline bg-panel p-3">
            {contactId ? <RevealPhone contactId={contactId} /> : null}
            <StageControl
              conversationId={conversation.id}
              stage={conversation.stage}
              onStageChange={handleStageChange}
            />
            <EventDateSection eventDate={conversation.eventDate ?? null} />
          </div>

          {/* The template writer moved to the composer - see MessageTemplatesDialog. It belongs
              beside the message you are about to send, not in the reference panel: reaching it
              used to mean leaving the thread, and on a phone that is a whole screen away. */}
          <MobileDisclosure
            title="AI assistant"
            hint={conversation.aiAutomationEnabled ? 'On' : 'Off'}
          >
            <ServiceSection
              conversationId={conversation.id}
              aiCategory={conversation.aiCategory ?? null}
              onCategoryChange={bumpActivity}
            />
            <AiAutomationSection
              conversationId={conversation.id}
              aiAutomationEnabled={conversation.aiAutomationEnabled ?? false}
              aiAutomationPausedReason={conversation.aiAutomationPausedReason ?? null}
              optedOutAt={conversation.optedOutAt ?? null}
              onAutomationChange={bumpActivity}
            />
          </MobileDisclosure>

          <MobileDisclosure title="Lead score" hint={`${conversation.leadScore ?? 0}/100`}>
            <LeadScoreSection
              leadScore={conversation.leadScore ?? 0}
              leadScoreBand={conversation.leadScoreBand ?? 'low_intent'}
              leadScoreSignals={conversation.leadScoreSignals ?? []}
            />
          </MobileDisclosure>

          <MobileDisclosure title="Enquiry & tags">
            <LeadFormSection conversationId={conversation.id} />
            <TagsSection
              conversationId={conversation.id}
              tagIds={conversation.tags}
              onTagsChange={bumpActivity}
            />
          </MobileDisclosure>

          <MobileDisclosure title="Notes & follow-ups">
            <NotesSection conversationId={conversation.id} />
            <FollowUpsSection conversationId={conversation.id} />
          </MobileDisclosure>

          {canAssign ? (
            <MobileDisclosure title="Assignment">
              <AssignmentControl
                conversationId={conversation.id}
                assignedTo={conversation.assignedTo}
                onAssignmentChange={bumpActivity}
              />
            </MobileDisclosure>
          ) : null}

          <MobileDisclosure title="Activity">
            <ActivitySection conversationId={conversation.id} refreshKey={activityKey} />
          </MobileDisclosure>

          {/* Outside the groups and last, so a destructive action is never one tap from a
              header someone opened looking for something else. */}
          {canDelete ? (
            <div className="rounded-[var(--m-radius-card)] border border-danger/30 p-3">
              <DeleteChatSection
                conversationId={conversation.id}
                displayName={conversation.displayName}
                onDeleted={onDeleted}
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          <StageControl
            conversationId={conversation.id}
            stage={conversation.stage}
            onStageChange={handleStageChange}
          />

          {/* Which playbook is driving this conversation - see ServiceSection on why `unknown` shows. */}
          <ServiceSection
            conversationId={conversation.id}
            aiCategory={conversation.aiCategory ?? null}
            onCategoryChange={bumpActivity}
          />

          {/* Renders nothing until the lead has given us a date we can read. */}
          <EventDateSection eventDate={conversation.eventDate ?? null} />

          <LeadScoreSection
            leadScore={conversation.leadScore ?? 0}
            leadScoreBand={conversation.leadScoreBand ?? 'low_intent'}
            leadScoreSignals={conversation.leadScoreSignals ?? []}
          />

          <AiAutomationSection
            conversationId={conversation.id}
            aiAutomationEnabled={conversation.aiAutomationEnabled ?? false}
            aiAutomationPausedReason={conversation.aiAutomationPausedReason ?? null}
            optedOutAt={conversation.optedOutAt ?? null}
            onAutomationChange={bumpActivity}
          />

          {/* The template writer moved to the composer - see MessageTemplatesDialog. It belongs
              beside the message you are about to send rather than in the reference panel.
              MessageTemplatesSection itself is unchanged and is rendered there. */}
          {canAssign ? (
            <AssignmentControl
              conversationId={conversation.id}
              assignedTo={conversation.assignedTo}
              onAssignmentChange={bumpActivity}
            />
          ) : null}

          {contactId ? <RevealPhone contactId={contactId} /> : null}

          {/* Renders nothing unless this lead came in through a form. */}
          <LeadFormSection conversationId={conversation.id} />

          <TagsSection
            conversationId={conversation.id}
            tagIds={conversation.tags}
            onTagsChange={bumpActivity}
          />

          <NotesSection conversationId={conversation.id} />

          <FollowUpsSection conversationId={conversation.id} />

          <ActivitySection conversationId={conversation.id} refreshKey={activityKey} />

          {/* Last, and only for roles that hold the permission - `staff` deliberately cannot delete. */}
          {canDelete ? (
            <DeleteChatSection
              conversationId={conversation.id}
              displayName={conversation.displayName}
              onDeleted={onDeleted}
            />
          ) : null}
        </div>
      )}
    </aside>
  );
};

export default LeadPanel;
