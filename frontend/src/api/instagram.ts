/**
 * Instagram DM settings.
 *
 * THESE GO TO NODE, NOT PYTHON. Caddy routes `/api/v1/instagram/*` to the Node service, where the
 * Meta integration and the Page tokens live. The dashboard does not need to know that, but anyone
 * adding a route here does: putting one outside this prefix sends it to a service that has never
 * heard of Instagram.
 *
 * THERE IS NO `getPageToken`. The server does not expose one, so there is nothing here that could
 * return it.
 */
import { apiFetch } from './client';
import { type ApiSuccessResponse } from '../types';

interface TokenParams {
  token: string | null;
}

export interface InstagramKeywordReply {
  keyword: string;
  reply: string;
}

export interface InstagramAccount {
  id: string;
  instagramAccountId: string | null;
  username: string | null;
  pageId: string | null;
  pageName: string | null;
  accessTokenLast4: string | null;
  status: 'active' | 'needs_attention' | 'disconnected' | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastInboundAt: string | null;
  automationEnabled: boolean;
  welcomeReply: string | null;
  keywordReplies: InstagramKeywordReply[];
}

/** A Page the admin could connect, and its Instagram account if it has one. */
export interface InstagramCandidate {
  pageId: string;
  pageName: string | null;
  instagram: { id: string; username: string | null } | null;
}

export const listInstagramAccounts = ({
  token,
}: TokenParams): Promise<ApiSuccessResponse<InstagramAccount[]>> =>
  apiFetch('/instagram/accounts', { token });

export const listInstagramCandidates = ({
  token,
}: TokenParams): Promise<ApiSuccessResponse<InstagramCandidate[]>> =>
  apiFetch('/instagram/available', { token });

export const connectInstagramAccount = ({
  token,
  ...body
}: TokenParams & {
  pageId: string;
  instagramAccountId: string;
  username?: string | null;
  pageName?: string | null;
}): Promise<ApiSuccessResponse<InstagramAccount>> =>
  apiFetch('/instagram/accounts', { method: 'POST', token, body });

export const updateInstagramAutomation = ({
  token,
  accountId,
  ...body
}: TokenParams & {
  accountId: string;
  automationEnabled?: boolean;
  welcomeReply?: string | null;
  keywordReplies?: InstagramKeywordReply[];
}): Promise<ApiSuccessResponse<InstagramAccount>> =>
  apiFetch(`/instagram/accounts/${accountId}/automation`, { method: 'PATCH', token, body });

export const disconnectInstagramAccount = ({
  token,
  accountId,
}: TokenParams & { accountId: string }): Promise<ApiSuccessResponse<InstagramAccount>> =>
  apiFetch(`/instagram/accounts/${accountId}/disconnect`, { method: 'POST', token });

/** Takes a thread off automation, or hands it back. */
export const setInstagramTakeover = ({
  token,
  conversationId,
  resume,
}: TokenParams & { conversationId: string; resume: boolean }): Promise<
  ApiSuccessResponse<{ id: string; aiAutomationEnabled: boolean; aiAutomationPausedReason: string | null }>
> =>
  apiFetch(`/instagram/threads/${conversationId}/takeover`, {
    method: 'POST',
    token,
    body: { resume },
  });
