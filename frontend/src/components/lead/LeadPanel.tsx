import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, type ConversationSummary } from '../types';
import ActivitySection from './ActivitySection';
import AiAutomationSection from './AiAutomationSection';
import AiProposalSection from './AiProposalSection';
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
};

const LeadPanel = ({ conversation, contactId, onStageChange, onDeleted }: Props) => {
  const { permissions } = useAuth() as AuthValue;
  const canAssign = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_ASSIGN);
  const canDraftProposal = hasPermission(permissions, PERMISSIONS.AI_GENERATE);
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
      className="flex h-full w-full shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-white p-4 xl:w-80"
    >
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

      {canDraftProposal ? (
        <AiProposalSection conversationId={conversation.id} displayName={conversation.displayName} />
      ) : null}

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
    </aside>
  );
};

export default LeadPanel;
