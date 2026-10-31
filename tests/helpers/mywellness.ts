import { http, HttpResponse, type HttpHandler } from "msw";
import { APP_ID } from "../../src/auth/constants.js";
import type { Session } from "../../src/auth/session-store.js";

export const LOGIN_URL = "https://core.mywellness.com/v2/enduser/authentication/login";
export const SERVICES = "https://services.mywellness.com/my-gym";
export const USER = `${SERVICES}/Training/User/u1`;

export const LOGIN_RESPONSE = {
  data: {
    token: "tok-1",
    userContext: { id: "u1", firstName: "Ana", lastName: "B", defaultCulture: "en-GB", measurementSystem: "Metric" },
    facilities: [{ id: "f1", url: "my-gym", name: "My Gym" }],
  },
};

export function session(token = "tok-1"): Session {
  return {
    token,
    savedAt: 0,
    user: {
      userId: "u1",
      firstName: "Ana",
      lastName: "B",
      nickName: "",
      measurementSystem: "Metric",
      culture: "en-GB",
      facilities: [{ id: "f1", url: "my-gym", name: "My Gym" }],
    },
  };
}

export interface Seen {
  url: string;
  body: unknown;
  headers: Headers;
}

/** A login handler that hands out `tok-1`, `tok-2`, ... and records each request. */
export function loginHandler(seen: Seen[]): HttpHandler {
  let n = 0;
  return http.post(LOGIN_URL, async ({ request }) => {
    seen.push({ url: request.url, body: await request.json(), headers: request.headers });
    if (request.headers.get("x-mwapps-appid") !== APP_ID) {
      return HttpResponse.json({ errors: [{ details: "ClientApplicationNotTrusted" }] });
    }
    n++;
    return HttpResponse.json({ data: { ...LOGIN_RESPONSE.data, token: `tok-${n}` } });
  });
}
