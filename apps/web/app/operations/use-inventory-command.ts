'use client';

import { useEffect, useRef, useState } from 'react';

export type InventoryPendingCommand = {
  url: string;
  body: string;
  key: string;
  ifMatch?: string;
  ownerId?: string;
};
export type InventoryCommandInput = InventoryPendingCommand;
export type InventoryCommandRunner = {
  run: (command: InventoryCommandInput) => Promise<boolean>;
  retry: () => Promise<boolean>;
  pending: InventoryPendingCommand | null;
  busy: boolean;
  notice: string;
};

export function useInventoryCommand(
  onSuccess: () => void,
  csrfToken: string | undefined,
  actorId: string | undefined,
  apiOrigin: string,
): InventoryCommandRunner {
  const busyRef = useRef(false);
  const pendingRef = useRef<InventoryPendingCommand | null>(null);
  const csrfRef = useRef(csrfToken);
  const [pending, setPending] = useState<InventoryPendingCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    csrfRef.current = csrfToken;
  }, [csrfToken]);
  function retain(command: InventoryPendingCommand, message: string) {
    const frozen = Object.freeze({ ...command });
    pendingRef.current = frozen;
    setPending(frozen);
    setNotice(message);
  }
  function clear() {
    pendingRef.current = null;
    setPending(null);
  }
  async function execute(command: InventoryPendingCommand, retrying: boolean): Promise<boolean> {
    if (busyRef.current || (!retrying && pendingRef.current !== null)) return false;
    const hadPending = pendingRef.current !== null;
    if (retrying && command.ownerId && actorId && command.ownerId !== actorId) {
      retain(command, 'Sign back in as the original operator before retrying this command.');
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (retrying) {
        const sessionResponse = await fetch(`${apiOrigin}/api/v1/auth/sessions/current`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!sessionResponse.ok) {
          retain(
            command,
            'Your session needs sign-in or recent MFA. The exact command is retained.',
          );
          return false;
        }
        const current = (await sessionResponse.json()) as {
          user?: { id?: unknown };
          csrfToken?: unknown;
        };
        if (command.ownerId && current.user?.id !== command.ownerId) {
          retain(command, 'Sign back in as the original operator before retrying this command.');
          return false;
        }
        if (typeof current.csrfToken === 'string') csrfRef.current = current.csrfToken;
      }
      const response = await fetch(command.url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfRef.current ? { 'X-CSRF-Token': csrfRef.current } : {}),
          ...(command.ifMatch ? { 'If-Match': command.ifMatch } : {}),
          'Idempotency-Key': command.key,
        },
        body: command.body,
      });
      if (response.ok) {
        clear();
        setNotice('Inventory command completed.');
        onSuccess();
        return true;
      }
      let code = '';
      try {
        const problem = (await response.clone().json()) as { code?: unknown };
        code = typeof problem.code === 'string' ? problem.code : '';
      } catch {
        /* gateway responses may not be JSON */
      }
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500 ||
        code === 'INVENTORY_COMMAND_IN_PROGRESS'
      ) {
        retain(command, 'The command may still be processing. Retry the exact command.');
        return false;
      }
      if (response.status === 401 || response.status === 403) {
        if (hadPending)
          retain(
            command,
            'Your session needs sign-in or recent MFA. The exact command is retained.',
          );
        else {
          clear();
          setNotice('Your session needs sign-in or recent MFA.');
        }
        return false;
      }
      clear();
      setNotice(
        response.status === 409
          ? 'The resource changed or the command was rejected. Refresh before starting a new command.'
          : 'The command was rejected. Refresh before starting a new command.',
      );
      onSuccess();
      return false;
    } catch {
      retain(command, 'Network uncertainty: the exact command and key remain available for retry.');
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return {
    run: (command) => execute({ ...command, ownerId: actorId }, false),
    retry: () => (pendingRef.current ? execute(pendingRef.current, true) : Promise.resolve(false)),
    pending,
    busy,
    notice,
  };
}
