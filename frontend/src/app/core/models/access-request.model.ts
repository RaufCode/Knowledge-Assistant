import type { Role } from './auth.model';

/**
 * `POST /api/auth/request-access` request body.
 *
 * `role` is what the person is **asking** for. It is recorded so an administrator can
 * see it and decide, and it grants nothing: the role on the account is the one the
 * approval carried, and the approval only an administrator sends.
 */
export interface AccessRequestDto {
  name: string;
  email: string;
  role: Role;
  password: string;
}

/**
 * The answer to a request for access.
 *
 * Carries nothing but a status. The endpoint is unauthenticated, so anything more
 * informative would be a way to ask it which addresses already have accounts.
 */
export interface AccessRequestSubmittedDto {
  status: 'received';
}

/** Where a request has got to. */
export type AccessRequestStatus = 'pending' | 'approved' | 'declined';

/** One request, as an administrator sees it. */
export interface AccessRequestRowDto {
  id: string;
  name: string;
  email: string;
  status: AccessRequestStatus;
  /**
   * What they asked for, shown to the administrator as the thing to check.
   *
   * Null on requests made before this existed, and it is never what gets granted —
   * that is the role on the approve call, which defaults to the least privileged one.
   */
  requested_role: Role | null;
  /** ISO timestamp. The backend sends no designator, so it is read as UTC. */
  requested_at: string;
  decided_at: string | null;
}

/** `GET /api/auth/requests` response. */
export interface AccessRequestListDto {
  requests: AccessRequestRowDto[];
}

/** `POST /api/auth/requests/{id}/approve` request body. */
export interface AccessRequestDecisionRequestDto {
  role: Role;
}

/**
 * The outcome of a decision.
 *
 * `invite_link` is empty for a decline, and for an approval where the account had
 * already been provisioned another way. Empty rather than null because the field is
 * always there and only sometimes has anything in it.
 */
export interface AccessRequestDecisionDto {
  request: AccessRequestRowDto;
  invite_link: string;
  token: string;
  expires_at: string;
}

/** `POST /api/auth/accounts` request body. */
export interface CreateAccountRequestDto {
  name: string;
  email: string;
  role: Role;
  password: string;
}


/**
 * One account, as an administrator's list shows it.
 *
 * Names, addresses and roles only. No session, no password, nothing about the person
 * that is not about the person.
 */
export interface UserSummaryDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** False for a registration still waiting on an administrator. */
  is_active: boolean;
  created_at: string;
}

/**
 * `GET /api/auth/users` response: one page, and enough to render the pager.
 *
 * `pages` rather than a bare count so the control does not do the arithmetic and
 * cannot disagree with the server about how many there are.
 */
export interface UserListDto {
  users: UserSummaryDto[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

/**
 * `PATCH /api/auth/users/{id}` request body.
 *
 * Every field optional and independent, so changing a role does not require retyping
 * an address and an address change does not require choosing a role. A field that was
 * not sent is left alone.
 */
export interface UserUpdateRequestDto {
  name?: string;
  email?: string;
  role?: Role;
  is_active?: boolean;
}

/** `POST /api/auth/users/{id}/password` request body. */
export interface PasswordResetRequestDto {
  password: string;
}

/** `POST /api/auth/me/password` request body: anybody changes their own. */
export interface ChangeOwnPasswordRequestDto {
  current_password: string;
  new_password: string;
}

/**
 * The answer to a sign-in where the account exists but is not switched on.
 *
 * Sent only when the password was correct, which is what makes it safe to send: the
 * caller has proved they own the account by knowing its password, so it discloses
 * nothing to anybody else.
 */
export interface PendingApprovalDto {
  status: 'pending';
  name: string;
  requested_role: Role | null;
}
