export function isHttpUrl(url: string): boolean {
    if (!url || typeof url !== "string") return false;
    
    const isSchemeValid = /^https?:\/\//i.test(url.trim());
    if (!isSchemeValid) return false;

    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}