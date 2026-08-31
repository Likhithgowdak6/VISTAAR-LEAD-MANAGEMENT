import { ACCOUNT_ACCESS_MODES, type AccountAccessMode } from '../../constants/account-access-modes.js';
import { type ObjectIdLike } from '../../types/common.js';

/** The slice of a user this service needs, so callers can pass a document or a plain object. */
export interface AccountAccessSubject {
  accountAccessMode?: AccountAccessMode | null;
  accountAccess?: readonly ObjectIdLike[] | null;
}

export interface CanUserAccessAccountParams {
  user: AccountAccessSubject;
  accountId: ObjectIdLike;
}

/**
 * Whether a user may act on one WhatsApp account.
 *
 * `selected` with an **empty** list means "no restriction has been configured", not "no
 * accounts". Every user created before account access was enforced carries exactly that shape,
 * and reading it as a deny-all would silently take sending away from the whole team. The
 * restriction begins the moment an admin actually picks accounts for the user.
 */
export const canUserAccessAccount = ({ user, accountId }: CanUserAccessAccountParams): boolean => {
  if (user.accountAccessMode === ACCOUNT_ACCESS_MODES.ALL) {
    return true;
  }

  const allowedAccounts = user.accountAccess ?? [];

  if (allowedAccounts.length === 0) {
    return true;
  }

  const targetAccountId = accountId.toString();

  return allowedAccounts.some((allowedAccount) => allowedAccount.toString() === targetAccountId);
};

export interface FilterAccessibleAccountsParams<TAccount extends { _id: ObjectIdLike }> {
  user: AccountAccessSubject;
  accounts: readonly TAccount[];
}

export const filterAccessibleAccounts = <TAccount extends { _id: ObjectIdLike }>({
  user,
  accounts,
}: FilterAccessibleAccountsParams<TAccount>): TAccount[] =>
  accounts.filter((account) => canUserAccessAccount({ user, accountId: account._id }));
