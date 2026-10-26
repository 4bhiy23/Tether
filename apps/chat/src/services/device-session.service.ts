import { auth } from "../auth.js";

type AuthApi = Pick<typeof auth.api, "getSession" | "listSessions" | "revokeSession">;

export function createDeviceSessionService(api: AuthApi = auth.api) {
  return {
    getCurrent(headers: Headers) {
      return api.getSession({ headers });
    },

    async revoke(headers: Headers, sessionId: string) {
      if (!(await api.getSession({ headers }))) return { status: "unauthenticated" } as const;

      const target = (await api.listSessions({ headers })).find((session) => session.id === sessionId);
      if (!target) return { status: "not-found" } as const;

      await api.revokeSession({ body: { token: target.token }, headers });
      return { status: "revoked", sessionId: target.id } as const;
    },
  };
}

export const deviceSessionService = createDeviceSessionService();
export type DeviceSessionService = typeof deviceSessionService;
