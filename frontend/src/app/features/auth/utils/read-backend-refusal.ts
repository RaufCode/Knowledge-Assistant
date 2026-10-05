import { HttpErrorResponse } from '@angular/common/http';

import { ApiError } from '../../../core/services/api.service';

/**
 * What to say when the backend refuses a request the user filled in.
 *
 * The backend's own sentence, passed through rather than replaced. It is written for
 * the person who hit it and says what to do next — "That address already has an
 * account", "Use at least 8 characters", "Only your own questions can be edited" —
 * so replacing it with a generic sentence throws away the only part of the failure the
 * reader can act on.
 *
 * This matters more than it sounds. A 422 can be a bad email domain, a name over the
 * length limit or a missing field, and those have nothing to do with each other: one
 * canned "that email address is not one this workspace accepts" applied to all of
 * them sends the reader to fix the one field that was fine. An administrator told
 * their address is wrong will retype a correct one until they give up on the form.
 *
 * **Both error shapes are read.** `ApiService` reduces a conversation failure to an
 * `ApiError` carrying the backend's wording in `message`, while `AuthService` lets
 * the raw `HttpErrorResponse` through, where the same wording sits on `error.detail`.
 * Handling only one of them loses the reason on every screen of the other — which is
 * exactly what happened to the 409s here, which were read from a property neither
 * shape has on the path they actually took.
 *
 * Pydantic's wording is tidied on the way through: `Value error, ` and the trailing
 * `[type=...]` annotation are machinery rather than anything the reader needs.
 */
export function readBackendRefusal(error: unknown): string | null {
  const raw =
    error instanceof ApiError
      ? error.message
      : error instanceof HttpErrorResponse
        ? detailOf(error.error)
        : null;

  if (typeof raw !== 'string') {
    return null;
  }

  const message = raw
    .replace(/^value error,\s*/i, '')
    .replace(/\s*\[type=[^\]]*\]$/, '')
    .trim();

  return message || null;
}

/** The `detail` out of a FastAPI body, which is a string or an array of them. */
function detailOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('detail' in body)) {
    return null;
  }

  const { detail } = body as { detail: unknown };

  if (typeof detail === 'string') {
    return detail;
  }

  if (!Array.isArray(detail) || detail.length === 0) {
    return null;
  }

  const first = (detail as { msg?: unknown }[])[0];

  return typeof first?.msg === 'string' ? first.msg : null;
}

/**
 * A sentence for a refusal that carried no usable wording.
 *
 * Reached only when the body was not a shape this knows, so it says what is true —
 * something in the request was refused — rather than guessing which part.
 */
export const GENERIC_REFUSAL =
  'The request was refused. Please check the details you entered and try again.';

/**
 * The backend's own refusal, or a sentence when it did not send one.
 *
 * The one call every failure mapper wants, so "show the user what the server said"
 * is a single decision rather than one per screen.
 */
export function readRefusalOr(error: unknown, fallback: string): string {
  return readBackendRefusal(error) ?? fallback;
}