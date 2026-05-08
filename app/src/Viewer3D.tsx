import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Bounds, Center } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three-stdlib';
import { sharedTexture } from './textureStore';
import {
  FBX_FRONT_UV_BOUNDS,
  FRONT_CLOTH_MESH,
  SOURCE_MODEL_URL,
} from './modelAssets';

const VIEW_DIRS = {
  front: { dir: [0, 0.08, 1] as const, label: '正面' },
  back: { dir: [0, 0.08, -1] as const, label: '背面' },
  left: { dir: [-1, 0.08, 0.1] as const, label: '左袖' },
  right: { dir: [1, 0.08, 0.1] as const, label: '右袖' },
};
type ViewKey = keyof typeof VIEW_DIRS;

function configureSharedTexture() {
  const rangeU = FBX_FRONT_UV_BOUNDS.maxU - FBX_FRONT_UV_BOUNDS.minU;
  const rangeV = FBX_FRONT_UV_BOUNDS.maxV - FBX_FRONT_UV_BOUNDS.minV;
  sharedTexture.repeat.set(1 / rangeU, 1 / rangeV);
  sharedTexture.offset.set(
    -FBX_FRONT_UV_BOUNDS.minU / rangeU,
    -FBX_FRONT_UV_BOUNDS.minV / rangeV
  );
  sharedTexture.wrapS = THREE.ClampToEdgeWrapping;
  sharedTexture.wrapT = THREE.ClampToEdgeWrapping;
  sharedTexture.needsUpdate = true;
}

function FbxGarmentModel() {
  const gltf = useLoader(GLTFLoader, SOURCE_MODEL_URL);
  const cloned = useMemo(() => gltf.scene.clone(true), [gltf]);

  useEffect(() => {
    configureSharedTexture();
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const tuned = materials.map((material) => {
        const base = material as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
        const next = base.clone() as THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
        const map = (next as THREE.MeshStandardMaterial).map;
        if (map) {
          map.colorSpace = THREE.SRGBColorSpace;
          map.needsUpdate = true;
        }
        next.side = THREE.DoubleSide;
        // All cloth pieces are white. Front cloth additionally gets the
        // shared print texture; the others stay flat white.
        next.color = new THREE.Color('#ffffff');
        if ('metalness' in next) next.metalness = 0;
        if ('roughness' in next) next.roughness = 0.86;
        if (mesh.name === FRONT_CLOTH_MESH) {
          next.map = sharedTexture;
        }
        next.needsUpdate = true;
        return next;
      });
      mesh.material = Array.isArray(mesh.material) ? tuned : tuned[0];
    });
  }, [cloned]);

  return <primitive object={cloned} />;
}

function CameraRig({ view }: { view: ViewKey }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { target: THREE.Vector3; update: () => void }
    | null;

  useEffect(() => {
    if (!controls) return;
    const target = controls.target;
    const distance = camera.position.distanceTo(target);
    const [dx, dy, dz] = VIEW_DIRS[view].dir;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    camera.position.set(
      target.x + (dx / len) * distance,
      target.y + (dy / len) * distance,
      target.z + (dz / len) * distance
    );
    camera.lookAt(target);
    controls.update();
  }, [view, camera, controls]);

  return null;
}

export default function Viewer3D() {
  const [view, setView] = useState<ViewKey>('front');

  return (
    <div className="viewer-root">
      <Canvas
        camera={{ position: [0, 0.18, 1.7], fov: 30 }}
        dpr={[1.5, 3]}
        gl={{
          // ACESFilmic is built for HDR cinema — it desaturates highlights
          // ("filmic" rolloff), making pure-yellow → cream and pure-white →
          // off-white. For a mockup that just samples a texture under flat
          // lighting we want the raw texture colors to come through, so use
          // NoToneMapping. Switching this is the single biggest factor in
          // print colors looking dimmer in 3D vs. the source PNG.
          toneMapping: THREE.NoToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
          antialias: true,
          powerPreference: 'high-performance',
        }}
      >
        <color attach="background" args={['#ffffff']} />
        <ambientLight intensity={0.9} />
        <hemisphereLight args={['#ffffff', '#e5e7eb', 1.35]} />
        <directionalLight position={[3, 4, 5]} intensity={1.2} />
        <directionalLight position={[-4, 3, 2]} intensity={0.42} />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.08}>
            <Center>
              <FbxGarmentModel />
            </Center>
          </Bounds>
        </Suspense>
        <CameraRig view={view} />
        <OrbitControls makeDefault enableDamping enablePan={false} />
      </Canvas>

      <div className="view-selector">
        {(Object.keys(VIEW_DIRS) as ViewKey[]).map((v) => (
          <button
            key={v}
            className={`view-btn ${view === v ? 'active' : ''}`}
            onClick={() => setView(v)}
          >
            {VIEW_DIRS[v].label}
          </button>
        ))}
      </div>
    </div>
  );
}
