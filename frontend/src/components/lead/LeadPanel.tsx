import { useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { hasPermission, PERMISSIONS } from '../../lib/permissions';
import { type AuthValue, type ConversationSummary } from '../types';
import ActivitySection from './ActivitySection';
import AiAutomationSection from './AiAutomationSection';
import AiProposalSection from './AiProposalSection';
import AssignmentControl from './AssignmentControl';
import EventDateSection from './EventDateSection';
import FollowUpsSection from './FollowUpsSection';
import LeadFormSection from './LeadFormSection';
import LeadScoreSection from './LeadScoreSection';
import NotesSection from './NotesSection';
import RevealPhone from './RevealPhone';
import StageControl from './StageControl';
import TagsSection from './TagsSection';

type Props = {
  conversation: ConversationSummary;
  contactId?: string | null;
  onStageChange?: (stage: string) => void;
};

const LeadPanel = ({ conversation, contactId, onStageChange }: Props) => {
  const { permissions } = useAuth() as AuthValue;
  const canAssign = hasPermission(permissions, PERMISSIONS.CONVERSATIONS_ASSIGN);
  const canDraftProposal = hasPermission(permissions, PERMISSIONS.AI_GENERATE);

  // Bumping this key re-fetches the activity timeline after a mutating action.
  const [activityKey, setActivityKey] = useState(0);
  const bumpActivity = () => setActivityKey((value) => value + 1);

  const handleStageChange = (stage: string) => {
    onStageChange?.(stage);
    bumpActivity();
  };

  return (
    <aside
      aria-label="Lead details"
      className="flex h-full w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-white p-4"
    >
      <StageControl
        conversationId={conversation.id}
        stage={conversation.stage}
        onStageChange={handleStageChange}
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
    </aside>
  );
};

export default LeadPanel;
