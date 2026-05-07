import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_CANDIDATES = [
  "sanctum.session_token",
  "__Secure-sanctum.session_token",
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

function hasSessionCookie(request: NextRequest): boolean {
  return SESSION_COOKIE_CANDIDATES.some((cookieName) =>
    request.cookies.has(cookieName),
  );
}

export async function proxy(request: NextRequest) {
  const isAuthenticated = hasSessionCookie(request);
  const { pathname } = request.nextUrl;

  if (
    !isAuthenticated &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/signup") &&
    !pathname.startsWith("/auth") &&
    !pathname.startsWith("/api/auth")
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
