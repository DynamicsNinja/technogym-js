/** Account and login host. */
export const CORE_URL = "https://core.mywellness.com";
/** Training-data host; every path under it starts with the facility's url slug. */
export const SERVICES_URL = "https://services.mywellness.com";

/**
 * App id and name of the official end-user web app (endusernext.mywellness.com). Without these
 * headers the API answers `ClientApplicationNotTrusted`.
 */
export const APP_ID = "EC1D38D7-D359-48D0-A60C-D8C0B8FB9DF9";
export const APP_NAME = "enduserweb";
export const APP_VERSION = "1.0";

export const LOGIN_PATH = "/v2/enduser/authentication/login";

export const USER_AGENT = "technogym-js (+https://github.com/DynamicsNinja/technogym-js)";

/** The headers every mywellness request carries. */
export function appHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "user-agent": USER_AGENT,
    "x-mwapps-appid": APP_ID,
    "x-mwapps-client": APP_NAME,
    "x-mwapps-clientversion": `${APP_VERSION},${APP_NAME}`,
  };
}
