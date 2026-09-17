import type { NextRequest, ProxyConfig } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/**
 * Next 16 renamed the middleware file convention to `proxy.ts`. This runs
 * before every matched request: it refreshes the Supabase session and bounces
 * signed-out visitors to `/login`.
 */
export default async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config: ProxyConfig = {
  matcher: [
    /*
     * Everything except `_next/static`, `_next/image` and `favicon.ico`: build
     * output, the image optimizer and the one static file the app serves.
     *
     * `/login` IS matched. It is public, but it still has to run through here:
     * this is the only place that can write refreshed auth cookies onto a
     * response, and `/login` calls `getUser()` like every other route. Skipping
     * it meant an expired token was rotated upstream on the login page and the
     * new cookies thrown away, signing the user out. `updateSession` knows not
     * to redirect a request that is already heading for `/login`.
     */
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
  ],
};
