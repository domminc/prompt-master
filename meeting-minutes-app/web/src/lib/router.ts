import { useCallback, useEffect, useState } from "react";

/** 라우터 라이브러리 없이 쓰는 아주 작은 History API 라우터 (화면이 2개뿐이다) */
export function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (to === window.location.pathname) return;
    if (opts?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return { path, navigate };
}

export function matchJobPath(path: string): string | null {
  return /^\/jobs\/([0-9a-fA-F-]{36})\/?$/.exec(path)?.[1] ?? null;
}
