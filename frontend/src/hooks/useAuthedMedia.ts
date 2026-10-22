import { useEffect, useState } from 'react';

import { fetchMessageMedia } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { type AuthValue } from '../components/types';

export type AuthedMediaState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

/**
 * Fetches a message's attachment and exposes it as a blob URL.
 *
 * WHY A BLOB AND NOT A PLAIN URL. The API authenticates with a Bearer token held in memory, so
 * an `<img src="/api/v1/messages/x/media">` would arrive without it and 401. Signing the URL
 * instead would mean a credential in the query string, which ends up in history and logs. The
 * cost is that the file is fetched by JavaScript and held in memory while the bubble is mounted.
 *
 * THE REVOKE IS NOT HOUSEKEEPING. A blob URL pins its bytes for the lifetime of the document;
 * without the cleanup below, scrolling through a thread of photos leaks every one of them until
 * the tab is closed.
 *
 * CALLING THIS MEANS FETCHING. There is no `enabled` flag: deciding whether an attachment
 * should be downloaded at all belongs to the caller, which simply does not mount the component
 * that uses this hook. That keeps the fetch out of the render path for every bubble in a thread
 * whose bytes were never stored.
 */
export const useAuthedMedia = (messageId: string): AuthedMediaState => {
  const { authedRequest } = useAuth() as AuthValue;
  const [state, setState] = useState<AuthedMediaState>({ status: 'loading' });

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    const controller = new AbortController();

    authedRequest((token) => fetchMessageMedia({ token, messageId, signal: controller.signal }))
      .then((blob: Blob) => {
        // The component may have unmounted mid-flight; creating a URL now would leak it,
        // because the cleanup that would revoke it has already run.
        if (cancelled) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) {
          return;
        }

        // Expired, pruned, or never stored. The caller falls back to the label rather than
        // showing a broken frame.
        setState({
          status: 'error',
          message:
            error instanceof Error && error.message ? error.message : 'Attachment unavailable.',
        });
      });

    return () => {
      cancelled = true;
      controller.abort();

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [authedRequest, messageId]);

  return state;
};
