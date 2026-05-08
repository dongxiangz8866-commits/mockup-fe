import { Suspense, useMemo } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { Bounds, Center, ContactShadows, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader, MTLLoader, OBJLoader } from 'three-stdlib';

const MODEL_FILE = '霞湖世家男T-001(1)(2)';

const MODEL_ROUTES = [
  { path: '/model/obj-with-model', label: 'OBJ 有模特', dir: 'obj-with-model', kind: 'obj' },
  { path: '/model/fbx-with-model', label: 'FBX 有模特', dir: 'fbx-with-model', kind: 'fbx' },
  { path: '/model/obj-no-model', label: 'OBJ 无模特', dir: 'obj-no-model', kind: 'obj' },
  { path: '/model/fbx-no-model', label: 'FBX 无模特', dir: 'fbx-no-model', kind: 'fbx' },
] as const;

type ModelRoute = (typeof MODEL_ROUTES)[number];

function assetPath(route: ModelRoute, name: string): string {
  return `/mock-models/${route.dir}/${encodeURIComponent(name)}`;
}

function tuneObject(object: THREE.Object3D): THREE.Object3D {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const m = material as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
      const map = (m as THREE.MeshStandardMaterial).map;
      if (map) {
        map.colorSpace = THREE.SRGBColorSpace;
        map.needsUpdate = true;
      }
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  });
  return object;
}

function ObjModel({ route }: { route: ModelRoute }) {
  const basePath = `/mock-models/${route.dir}/`;
  const materials = useLoader(
    MTLLoader,
    assetPath(route, `${MODEL_FILE}.mtl`),
    (loader) => {
      loader.setResourcePath(basePath);
    }
  );
  materials.preload();
  const object = useLoader(
    OBJLoader,
    assetPath(route, `${MODEL_FILE}.obj`),
    (loader) => {
      loader.setMaterials(materials);
    }
  );
  const scene = useMemo(() => tuneObject(object.clone(true)), [object]);
  return <primitive object={scene} />;
}

function FbxModel({ route }: { route: ModelRoute }) {
  const object = useLoader(FBXLoader, assetPath(route, `${MODEL_FILE}.fbx`));
  const scene = useMemo(() => tuneObject(object.clone(true)), [object]);
  return <primitive object={scene} />;
}

function RouteModel({ route }: { route: ModelRoute }) {
  return route.kind === 'obj' ? <ObjModel route={route} /> : <FbxModel route={route} />;
}

function findRoute(): ModelRoute {
  return MODEL_ROUTES.find((r) => r.path === window.location.pathname) ?? MODEL_ROUTES[0];
}

export function isModelRoute(pathname: string): boolean {
  return MODEL_ROUTES.some((r) => r.path === pathname);
}

export default function SourceModelViewer() {
  const route = findRoute();

  return (
    <div className="source-viewer">
      <header className="source-topbar">
        <a className="source-back" href="/">
          样机系统
        </a>
        <nav className="source-tabs" aria-label="源模型路由">
          {MODEL_ROUTES.map((r) => (
            <a
              key={r.path}
              className={`source-tab ${r.path === route.path ? 'active' : ''}`}
              href={r.path}
            >
              {r.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="source-stage">
        <Canvas
          camera={{ position: [0, 1.25, 4.8], fov: 34 }}
          shadows
          dpr={[1, 2]}
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
        >
          <color attach="background" args={['#ffffff']} />
          <ambientLight intensity={1.1} />
          <hemisphereLight args={['#ffffff', '#e6e8ec', 1.8]} />
          <directionalLight
            position={[3.5, 5, 4]}
            intensity={1.6}
            castShadow
            shadow-mapSize={[2048, 2048]}
          />
          <directionalLight position={[-4, 3, 3]} intensity={0.45} />
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.18}>
              <Center>
                <RouteModel route={route} />
              </Center>
            </Bounds>
            <ContactShadows
              position={[0, -1.05, 0]}
              opacity={0.18}
              blur={3.5}
              far={3}
              scale={6}
            />
          </Suspense>
          <OrbitControls makeDefault enableDamping enablePan={false} />
        </Canvas>
        <div className="source-label">{route.label}</div>
      </main>
    </div>
  );
}
