// Debatidor — detector conservador de intención de guardado de media.
//
// Este módulo NO toca red ni disco. Solo convierte el último mensaje manual
// del usuario en una intención explícita que extension-save.js puede ejecutar
// fuera del contexto del modelo. Además separa la identidad de la fuente de la
// ruta destino: sourceStrategy decide QUÉ imagen del DOM usar y destinationFor
// decide únicamente CÓMO se llamará dentro del agente.
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

  function sourceStrategy(normalized) {
    // Frases deícticas: la fuente YA está visible y debe resolverse contra el
    // assistant turn inmediatamente anterior al último mensaje del usuario.
    const existingReference =
      /\b(?:esta|esa|this|that)\s+(?:imagen(?:es)?|image(?:s)?|foto(?:s)?|photo(?:s)?)\b/.test(normalized) ||
      /\b(?:imagen|image|foto|photo)\s+(?:anterior|previous|de\s+arriba|above)\b/.test(normalized) ||
      /\b(?:la|the)\s+(?:imagen|image|foto|photo)\s+(?:que\s+)?(?:acabas?\s+de|just)\s+(?:gener\w*|cre\w*)\b/.test(normalized) ||
      /\bno\s+(?:necesitas?|hace\s+falta)\s+(?:crear|generar)\s+otra\b/.test(normalized);
    if (existingReference) return 'previous-turn-image';

    // Si el mismo prompt pide generar/crear/dibujar una imagen, la fuente aún
    // no existía al nacer la intención y se espera la imagen de ese turno.
    const asksGeneration = /\b(?:gener\w*|crea\w*|create|generate|draw|dibuj\w*|haz)\b/.test(normalized);
    return asksGeneration ? 'wait-for-new-image' : 'previous-turn-image';
  }

  function parse(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const normalized = fold(raw);
    const paths = imagePaths(raw);
    const saveVerb = /\b(?:guard\w*|salv\w*|save|store|write|copy|pon(?:er|la|las|lo|los)?|pong(?:a|as|amos|an)|coloc\w*|mete\w*|meter|meta\w*|sube\w*|subir|suba\w*|lleva\w*)\b/.test(
      normalized,
    );
    const mentionsImage = /\b(?:imagen(?:es)?|image(?:s)?|foto(?:s)?|photo(?:s)?|png|jpe?g|webp|gif)\b/.test(
      normalized,
    );
    const negated =
      /\bno\s+(?:quiero\s+)?(?:guard|salv|sub|pong|pon|coloc)/.test(normalized) ||
      /\b(?:do\s+not|don't)\s+(?:save|store|copy|write|upload)\b/.test(normalized);
    if (!saveVerb || (!mentionsImage && paths.length === 0) || negated) return null;

    return {
      requested: true,
      sourceStrategy: sourceStrategy(normalized),
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
