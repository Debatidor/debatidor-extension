// Debatidor — detector conservador de intención de guardado de media.
//
// Este módulo NO toca red ni disco. Solo convierte el último mensaje manual
// del usuario en una intención explícita que extension-save.js puede ejecutar
// fuera del contexto del modelo. La regla deliberadamente exige verbo de
// guardado + referencia a imagen (o un nombre de archivo de imagen) para no
// convertir cualquier generación visual en una subida automática.
(function attachAssetSaveIntent(global) {
  const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
  const PATH_RE = /(?:^|[\s"'`(\[])((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`),.;:\]])/gi;

  function fold(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function safeRelativePath(value) {
    const path = String(value ?? '').trim().replace(/\\/g, '/');
    if (!path || path.length > 1000 || path.includes('\0')) return '';
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return '';
    if (path.split('/').some((part) => part === '..')) return '';
    return IMAGE_EXT_RE.test(path) ? path : '';
  }

  function imagePaths(text) {
    const out = [];
    const seen = new Set();
    const source = String(text ?? '');
    PATH_RE.lastIndex = 0;
    for (let match; (match = PATH_RE.exec(source)); ) {
      const path = safeRelativePath(match[1]);
      if (!path) continue;
      const key = path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(path);
    }
    return out;
  }

  function parseAgentId(text) {
    const source = String(text ?? '');
    const explicit = /\bagentId\s*=\s*["'`]?([A-Za-z0-9._-]{1,200})/i.exec(source);
    if (explicit) return explicit[1];
    const natural = /\b(?:agente|agent)\s+["'`]?([A-Za-z0-9._-]{1,200})\b/i.exec(source);
    return natural?.[1] ?? undefined;
  }

  function parseCount(folded) {
    const match = /\b(\d{1,2})\s+(?:imagenes?|images?|fotos?|photos?)\b/.exec(folded);
    const value = match ? Number(match[1]) : undefined;
    return Number.isInteger(value) && value >= 1 && value <= 20 ? value : undefined;
  }

  function parse(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const normalized = fold(raw);
    const paths = imagePaths(raw);
    const saveVerb = /\b(?:guarda(?:r|la|las|lo|los|me|mela|melas)?|guard(?:ar|a|e|en|es)|salva(?:r|la|las|lo|los)?|save|store|write|copy)\b/.test(
      normalized,
    );
    const mentionsImage = /\b(?:imagen(?:es)?|image(?:s)?|foto(?:s)?|photo(?:s)?|png|jpe?g|webp|gif)\b/.test(
      normalized,
    );
    const negated =
      /\bno\s+(?:quiero\s+)?(?:guard|salv)/.test(normalized) ||
      /\b(?:do\s+not|don't)\s+(?:save|store|copy|write)\b/.test(normalized);
    if (!saveVerb || (!mentionsImage && paths.length === 0) || negated) return null;

    return {
      requested: true,
      paths,
      agentId: parseAgentId(raw),
      count: parseCount(normalized),
      rootRequested: /\b(?:raiz|root)\b/.test(normalized),
    };
  }

  function extensionForMime(mimeType) {
    const mime = String(mimeType ?? '').toLowerCase();
    if (mime.includes('jpeg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return 'png';
  }

  function withIndex(path, index) {
    if (index === 0) return path;
    const dot = path.lastIndexOf('.');
    if (dot <= 0) return `${path}_${index + 1}`;
    return `${path.slice(0, dot)}_${index + 1}${path.slice(dot)}`;
  }

  function destinationFor(intent, index, mimeType) {
    const paths = Array.isArray(intent?.paths) ? intent.paths : [];
    if (paths[index]) return paths[index];
    if (paths.length === 1) return withIndex(paths[0], index);
    return `imagen_${index + 1}.${extensionForMime(mimeType)}`;
  }

  function hash32(value, seed) {
    let hash = seed >>> 0;
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function requestId(turnKey, href, path) {
    const material = `${turnKey}\u0000${href}\u0000${path}`;
    const first = hash32(material, 0x811c9dc5).toString(16).padStart(8, '0');
    const second = hash32(material, 0x9e3779b9).toString(16).padStart(8, '0');
    return `asr_${first}${second}`;
  }

  global.__debatidorAssetSaveIntent = {
    parse,
    destinationFor,
    requestId,
    safeRelativePath,
  };
})(globalThis);
