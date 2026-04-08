function getEnv(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

const rawBeeUrl = getEnv('VITE_READER_BEE_URL');
const useProxy = import.meta.env.DEV && isLocalUrl(rawBeeUrl);

export const config = {
  beeUrl: useProxy ? '/bee' : rawBeeUrl,
  appOwner: getEnv('VITE_APP_OWNER'),
  rawAppTopic: getEnv('VITE_APP_RAW_TOPIC'),
};
