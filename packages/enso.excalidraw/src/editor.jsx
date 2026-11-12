import './clipboard.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  defaultLang,
  exportToSvg,
  getNonDeletedElements,
  isElementLink,
  languages,
  restore,
  serializeAsJSON,
  useHandleLibrary,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { libraryAdapter } from './library.js';
import {
  decodeDocument,
  encodeDocument,
  formatOf,
  mergeScenes,
  sceneSignature,
  withSource,
} from '../scene.mjs';
import { createBufferSync } from '../sync.mjs';

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false,
    saveAsImage: false,
    toggleTheme: false,
    changeViewBackgroundColor: true,
    clearCanvas: true,
  },
  tools: { image: true },
};

function pickLanguage() {
  const codes = languages.map((language) => language.code);
  const tags = [...(navigator.languages ?? []), navigator.language].filter((tag) => typeof tag === 'string' && tag !== '');
  for (const tag of tags) {
    const exact = codes.find((code) => code.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const base = tag.split('-')[0].toLowerCase();
    const same = codes.find((code) => code.split('-')[0].toLowerCase() === base);
    if (same) return same;
  }
  return defaultLang.code;
}

function Library({ api }) {
  useHandleLibrary({
    excalidrawAPI: api,
    adapter: libraryAdapter,
    validateLibraryUrl: () => false,
  });
  return null;
}

async function renderSvg(scene) {
  const elements = getNonDeletedElements(scene.elements ?? []);
  const svg = await exportToSvg({
    elements,
    appState: {
      ...scene.appState,
      exportBackground: scene.appState?.viewBackgroundColor !== 'transparent',
    },
    files: scene.files ?? {},
    exportPadding: 16,
    skipInliningFonts: true,
  });
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return svg.outerHTML;
}

function sceneJson(scene) {
  const elements = getNonDeletedElements(scene.elements ?? []);
  return withSource(serializeAsJSON(elements, scene.appState ?? {}, scene.files ?? {}, 'local'), scene.source);
}

/** 编辑器挂上之前到达的外部改动先记在这里。 */
const bridge = { apply: null, pending: null };

function Editor({ sync, initial }) {
  const [theme, setTheme] = useState(() => (window.enso?.theme === 'dark' ? 'dark' : 'light'));
  const [language] = useState(pickLanguage);
  const [view, setView] = useState(() => ({ scene: initial, mountKey: 0 }));
  const [api, setApi] = useState(null);
  const apiRef = useRef(null);
  const shown = useRef(undefined);
  const svgRef = useRef(initial.svg ?? null);
  const sourceRef = useRef(initial.source);
  const renderEpoch = useRef(0);

  useEffect(() => window.enso?.onTheme?.((next) => setTheme(next === 'dark' ? 'dark' : 'light')) ?? (() => {}), []);

  const pushSvg = (scene) => {
    if (formatOf(window.enso.file.rel) !== 'svg' || scene?.error) return;
    const epoch = ++renderEpoch.current;
    renderSvg(scene)
      .then((svg) => {
        if (epoch !== renderEpoch.current) return;
        svgRef.current = svg;
        sync.noteEdit({ ...scene, svg });
      })
      .catch(() => {
        /* 画面没重画出来时，嵌入的场景仍然会写回 */
      });
  };

  useEffect(() => {
    bridge.apply = (scene, reason) => {
      sourceRef.current = scene?.source;
      svgRef.current = scene?.svg ?? null;
      shown.current = undefined;
      const current = apiRef.current;
      if (!current || scene?.error) {
        setView((previous) => ({ scene, mountKey: previous.mountKey + 1 }));
        return;
      }
      const restored = restore(
        { elements: scene.elements, appState: scene.appState, files: scene.files },
        null,
        null,
        { repairBindings: true },
      );
      current.addFiles(Object.values(restored.files ?? {}));
      current.updateScene({
        elements: restored.elements,
        appState: restored.appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      current.history.clear();
      if (reason === 'merge') pushSvg(scene);
    };
    if (bridge.pending) {
      const queued = bridge.pending;
      bridge.pending = null;
      bridge.apply(queued.scene, queued.reason);
    }
    return () => {
      bridge.apply = null;
    };
  });

  const initialData = useMemo(() => {
    if (view.scene?.error) return null;
    const restored = restore(
      { elements: view.scene.elements, appState: view.scene.appState, files: view.scene.files },
      null,
      null,
      { repairBindings: true },
    );
    return { ...restored, scrollToContent: true };
  }, [view.scene]);

  const onChange = (elements, appState, files) => {
    if (appState.isLoading) return;
    const signature = sceneSignature(elements, appState, files);
    // 加载和外部替换都会先规范化一次，那不是用户的编辑。
    if (shown.current === undefined) {
      shown.current = signature;
      return;
    }
    if (signature === shown.current) return;
    shown.current = signature;
    const kept = getNonDeletedElements(elements);
    const scene = {
      format: formatOf(window.enso.file.rel),
      elements: kept,
      appState,
      files: files ?? {},
      source: sourceRef.current,
      svg: svgRef.current,
      json: withSource(serializeAsJSON(kept, appState, files ?? {}, 'local'), sourceRef.current),
    };
    sync.noteEdit(scene);
    pushSvg(scene);
  };

  const onLinkOpen = (element, event) => {
    event.preventDefault();
    const link = element.link ?? '';
    if (isElementLink(link)) {
      apiRef.current?.scrollToContent(link, { animate: true });
      return;
    }
    if (/^https?:\/\//i.test(link)) window.enso?.call('open-link', { url: link }).catch(() => {});
  };

  if (view.scene?.error) {
    return <div className="excalidraw-error">无法打开这个 Excalidraw 文件：{view.scene.error}</div>;
  }

  return (
    <Excalidraw
      key={view.mountKey}
      excalidrawAPI={(next) => {
        apiRef.current = next;
        setApi(next);
      }}
      initialData={initialData}
      onChange={onChange}
      onLinkOpen={onLinkOpen}
      validateEmbeddable={false}
      aiEnabled={false}
      autoFocus
      theme={theme}
      langCode={language}
      UIOptions={UI_OPTIONS}
    >
      {api && <Library api={api} />}
      <MainMenu>
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
      <WelcomeScreen />
    </Excalidraw>
  );
}

function MissingFile() {
  return <div className="excalidraw-error">这个页面只能作为文件查看器打开。</div>;
}

const rootNode = createRoot(document.getElementById('root'));
const file = window.enso?.file;

if (!file) {
  rootNode.render(<MissingFile />);
} else {
  const sync = createBufferSync({
    file,
    decode: decodeDocument,
    encode: async (rel, scene) => {
      let json = scene.json;
      if (!json) {
        try {
          json = sceneJson(scene);
        } catch {
          json = undefined;
        }
      }
      return encodeDocument(rel, { ...scene, json });
    },
    merge: mergeScenes,
    apply: (scene, reason) => {
      if (bridge.apply) bridge.apply(scene, reason);
      else bridge.pending = { scene, reason };
    },
  });
  sync.ready
    .then((scene) => {
      rootNode.render(<Editor sync={sync} initial={scene} />);
    })
    .catch((error) => {
      rootNode.render(
        <div className="excalidraw-error">无法打开这个 Excalidraw 文件：{error?.message ?? error}</div>,
      );
    });
}
