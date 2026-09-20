import { useEffect, useState } from "react";

// Matches a CSS media query, e.g. useMediaQuery("(max-width: 1023px)").
// False until mounted, so the server and the first client render agree.
export const useMediaQuery = (query: string) => {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);

    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
};
