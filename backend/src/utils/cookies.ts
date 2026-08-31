export type ParsedCookies = Record<string, string>;

export const parseCookies = (cookieHeader = ''): ParsedCookies => {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(';').reduce<ParsedCookies>((cookies, cookiePart) => {
    const [rawName, ...rawValueParts] = cookiePart.trim().split('=');

    if (!rawName) {
      return cookies;
    }

    cookies[decodeURIComponent(rawName)] = decodeURIComponent(rawValueParts.join('='));

    return cookies;
  }, {});
};

export interface SerializeCookieOptions {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  maxAge?: number;
}

export const serializeCookie = ({
  name,
  value,
  httpOnly = true,
  secure = false,
  sameSite = 'Lax',
  path = '/',
  maxAge,
}: SerializeCookieOptions): string => {
  const cookieParts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];

  if (httpOnly) {
    cookieParts.push('HttpOnly');
  }

  if (secure) {
    cookieParts.push('Secure');
  }

  if (Number.isInteger(maxAge)) {
    cookieParts.push(`Max-Age=${maxAge}`);
  }

  return cookieParts.join('; ');
};
