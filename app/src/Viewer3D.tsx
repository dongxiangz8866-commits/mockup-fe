import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  useGLTF,
  Bounds,
  ContactShadows,
  Center,
} from '@react-three/drei';
import * as THREE from 'three';
import { sharedTexture } from './textureStore';

const MODEL_URL = '/sweatshirt.glb';
useGLTF.preload(MODEL_URL);

const VIEW_DIRS = {
  front: { dir: [0, 0.18, 1] as const, label: '正面' },
  back: { dir: [0, 0.18, -1] as const, label: '背面' },
  left: { dir: [-1, 0.18, 0.1] as const, label: '左袖' },
  right: { dir: [1, 0.18, 0.1] as const, label: '右袖' },
};
type ViewKey = keyof typeof VIEW_DIRS;

function Sweatshirt() {
  const { scene } = useGLTF(MODEL_URL) as unknown as { scene: THREE.Group };
  const cloned = useMemo(() => scene.clone(true), [scene]);

  useEffect(() => {
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const baseMat = mesh.material as
        | THREE.MeshStandardMaterial
        | THREE.MeshStandardMaterial[];
      const apply = (m: THREE.MeshStandardMaterial) => {
        const next = m.clone();
        next.map = sharedTexture;
        next.color = new THREE.Color('#ffffff');
        next.metalness = 0;
        next.roughness = 0.85;
        next.emissive = new THREE.Color('#000000');
        next.emissiveMap = null;
        next.needsUpdate = true;
        return next;
      };
      mesh.material = Array.isArray(baseMat) ? baseMat.map(apply) : apply(baseMat);
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
          toneMapping: THREE.NoToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
          antialias: true,
          powerPreference: 'high-performance',
        }}
      >
        <color attach="background" args={['#f5f6f8']} />
        <ambientLight intensity={0.6} />
        <hemisphereLight args={['#ffffff', '#d1d5db', 0.8]} />
        <directionalLight position={[2, 4, 5]} intensity={0.85} />
        <directionalLight position={[-3, 2, 2]} intensity={0.45} />
        <directionalLight position={[0, -2, 3]} intensity={0.25} />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.15}>
            <Center>
              <Sweatshirt />
            </Center>
          </Bounds>
          <ContactShadows
            position={[0, -0.62, 0]}
            opacity={0.22}
            blur={3}
            far={1.2}
            scale={3.5}
          />
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
