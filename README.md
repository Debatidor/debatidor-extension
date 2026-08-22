# debatidor-extension

Extensión de navegador (Manifest V3) para Google Chrome, Brave y Microsoft Edge. Actúa como puente de inferencia para conectar sesiones de chats web de inteligencia artificial (ej. Qwen, ChatGPT, Claude) a las salas de debate en vivo de **Debatidor**.

---

## Características

- **Smart DOM Observer**: Utiliza un motor de observación reactiva (`MutationObserver`) para detectar en tiempo real los estados del modelo web:
  - `thinking`: Razonamiento activo y deltas de pensamiento.
  - `generating`: Streaming continuo de tokens de respuesta.
  - `completed`: Detección automática del cierre de generación y extracción de código limpio.
- **Arquitectura de Host Adapters**: Módulos desacoplados de selección y extracción específicos para cada plataforma web compatible (`chat.qwen.ai`, `chatgpt.com`, `claude.ai`, `gemini.google.com`).
- **Canal WebSocket Seguro**: Transmisión bidireccional de baja latencia contra el gateway de Debatidor.

---

## Instalación en Modo Desarrollador

1. Asegúrate de tener el backend de Debatidor en ejecución (`http://localhost:3001` o tu endpoint en la nube).
2. Abre tu navegador y dirígete a `chrome://extensions`.
3. Activa el **Modo Desarrollador** (esquina superior derecha).
4. Haz clic en **Cargar descomprimida** (*Load unpacked*) y selecciona la carpeta de este repositorio.
5. Abre la pestaña del chat web que deseas utilizar (ej. `https://chat.qwen.ai`).
6. Haz clic en el icono de la extensión en la barra de herramientas para verificar el estado de conexión y vincular la sesión.

---

## Plataformas Web Soportadas

| Plataforma | URL | Estado |
|---|---|---|
| Qwen Chat | `https://chat.qwen.ai` | **Disponible** |
| ChatGPT | `https://chatgpt.com` | En desarrollo |
| Claude | `https://claude.ai` | En desarrollo |
| Google Gemini | `https://gemini.google.com` | En desarrollo |

---

## Documentación y Contratos

Para especificaciones sobre los protocolos `extension.dom_prompt`, `turn.delta` y el Provider Adapter Layer (PAL), consulta [debatidor-docs](https://github.com/LeoPro23/debatidor-docs).
