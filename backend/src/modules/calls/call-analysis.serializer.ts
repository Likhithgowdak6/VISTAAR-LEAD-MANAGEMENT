import { serializeDate, serializeId, toPlainObject } from '../../utils/serialization.js';

/**
 * A call's transcript, summary and suggestions, as the detail screen reads them.
 *
 * SPEAKER STAYS NULLABLE ALL THE WAY OUT. A transcript without labels is a complete transcript -
 * the likely outcome for Kannada, where the services that support the language do not offer
 * diarization - and the UI has to be able to render it without pretending it knows who spoke.
 * `diarized` tells it which of the two layouts to use.
 */

export interface SerializedTranscriptSegment {
  startSeconds: number | null;
  endSeconds: number | null;
  text: string;
  speaker: string | null;
}

export interface SerializedCallSuggestion {
  commitmentId: string;
  title: string;
  evidence: string | null;
  dueAt: string | null;
  status: string;
  taskId: string | null;
  decidedAt: string | null;
}

export interface SerializedCallAnalysis {
  callId: string | null;
  transcript: {
    segments: SerializedTranscriptSegment[];
    text: string;
    detectedLanguage: string | null;
    diarized: boolean;
    provider: string | null;
  } | null;
  summary: {
    overview: string;
    customerRequirements: string[];
    budget: string | null;
    expectedTimeline: string | null;
    preferences: string[];
    questionsAsked: string[];
    concerns: string[];
    decisions: string[];
    nextSteps: string[];
    inferences: string[];
    lowConfidence: boolean;
  } | null;
  suggestions: SerializedCallSuggestion[];
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

export const serializeCallAnalysis = (analysis: unknown): SerializedCallAnalysis | null => {
  const value = toPlainObject(analysis);

  if (!value) {
    return null;
  }

  const segments = Array.isArray(value.transcriptSegments) ? value.transcriptSegments : [];
  const summary = toPlainObject(value.summary);
  const suggestions = Array.isArray(value.suggestions) ? value.suggestions : [];

  return {
    callId: serializeId(value.callId),
    // Null rather than an empty transcript object when nothing has been transcribed, so the UI
    // can tell "no transcript" from "a transcript that turned out to be silent".
    transcript:
      segments.length > 0 || typeof value.transcriptText === 'string'
        ? {
            segments: segments.map((raw: unknown) => {
              const segment = toPlainObject(raw) ?? {};

              return {
                startSeconds:
                  typeof segment.startSeconds === 'number' ? segment.startSeconds : null,
                endSeconds: typeof segment.endSeconds === 'number' ? segment.endSeconds : null,
                text: typeof segment.text === 'string' ? segment.text : '',
                speaker: typeof segment.speaker === 'string' ? segment.speaker : null,
              };
            }),
            text: typeof value.transcriptText === 'string' ? value.transcriptText : '',
            detectedLanguage:
              typeof value.detectedLanguage === 'string' ? value.detectedLanguage : null,
            diarized: value.diarized === true,
            provider:
              typeof value.transcriptionProvider === 'string' ? value.transcriptionProvider : null,
          }
        : null,
    summary: summary
      ? {
          overview: typeof summary.overview === 'string' ? summary.overview : '',
          customerRequirements: asStringArray(summary.customerRequirements),
          budget: typeof summary.budget === 'string' ? summary.budget : null,
          expectedTimeline:
            typeof summary.expectedTimeline === 'string' ? summary.expectedTimeline : null,
          preferences: asStringArray(summary.preferences),
          questionsAsked: asStringArray(summary.questionsAsked),
          concerns: asStringArray(summary.concerns),
          decisions: asStringArray(summary.decisions),
          nextSteps: asStringArray(summary.nextSteps),
          inferences: asStringArray(summary.inferences),
          lowConfidence: summary.lowConfidence === true,
        }
      : null,
    suggestions: suggestions.map((raw: unknown) => {
      const suggestion = toPlainObject(raw) ?? {};

      return {
        commitmentId:
          typeof suggestion.commitmentId === 'string' ? suggestion.commitmentId : '',
        title: typeof suggestion.title === 'string' ? suggestion.title : '',
        evidence: typeof suggestion.evidence === 'string' ? suggestion.evidence : null,
        dueAt: serializeDate(suggestion.dueAt),
        status: typeof suggestion.status === 'string' ? suggestion.status : 'suggested',
        taskId: serializeId(suggestion.taskId),
        decidedAt: serializeDate(suggestion.decidedAt),
      };
    }),
  };
};
