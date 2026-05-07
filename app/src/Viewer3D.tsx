import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  useGLTF,
  Bounds,
  ContactShadows,
} from '@react-three/drei';
import * as THREE from 'three';
import { sharedTexture } from './textureStore';

const MODEL_URL = '/sweatshirt.glb';
useGLTF.preload(MODEL_URL);

const VIEWS = {
  front: { pos: [0, 0.35, 1.7] as const, label: '正面' },
  back: { pos: [0, 0.35, -1.7] as const, label: '背面' },
  left: { pos: [-1.7, 0.35, 0.2] as const, label: '左袖' },
  right: { pos: [1.7, 0.35, 0.2] as const, label: '右袖' },
};
type ViewKey = keyof typeof VIEWS;

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
    const [x, y, z] = VIEWS[view].pos;
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, [view, camera, controls]);

  return null;
}

export default function Viewer3D() {
  const [view, setView] = useState<ViewKey>('front');

  return (
    <div className="viewer-root">
      <div className="view-selector">
        {(Object.keys(VIEWS) as ViewKey[]).map((v) => (
          <button
            key={v}
            className={`view-btn ${view === v ? 'active' : ''}`}
            onClick={() => setView(v)}
          >
            {VIEWS[v].label}
          </button>
        ))}
      </div>

      <Canvas
        camera={{
          position: [VIEWS.front.pos[0], VIEWS.front.pos[1], VIEWS.front.pos[2]],
          fov: 30,
        }}
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
          <Bounds fit clip observe margin={1.05}>
            <Sweatshirt />
          </Bounds>
          <ContactShadows
            position={[0, -0.62, 0]}
            opacity={0.25}
            blur={3}
            far={1.2}
            scale={3.5}
          />
        </Suspense>
        <CameraRig view={view} />
        <OrbitControls makeDefault enableDamping enablePan={false} />
      </Canvas>
    </div>
  );
}
