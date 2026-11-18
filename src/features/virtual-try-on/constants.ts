export const SCENARIOS = [
  { value: "studio", label: "Estudio fotográfico", prompt: "in a clean photography studio with soft diffused light and a seamless warm-grey backdrop" },
  { value: "street", label: "Calle", prompt: "on a city street with natural daylight and a softly blurred urban background" },
  { value: "office", label: "Oficina", prompt: "in a bright modern office with natural light" },
  { value: "restaurant", label: "Restaurante", prompt: "in an elegant restaurant with warm ambient lighting" },
  { value: "outdoor", label: "Exterior", prompt: "outdoors in a park with soft natural light and greenery in the background" },
  { value: "neutral", label: "Fondo neutro", prompt: "against a plain neutral off-white background" },
] as const;

export const POSES = [
  { value: "standing", label: "De pie, de frente", prompt: "standing relaxed, facing the camera, full body visible" },
  { value: "three_quarter", label: "Tres cuartos", prompt: "standing in a three-quarter turn, full body visible" },
  { value: "walking", label: "Caminando", prompt: "walking naturally mid-stride, full body visible" },
  { value: "hands_pockets", label: "Manos en los bolsillos", prompt: "standing casually with hands in pockets, full body visible" },
  { value: "seated", label: "Sentado/a", prompt: "sitting comfortably, outfit clearly visible" },
] as const;

export type ScenarioKey = (typeof SCENARIOS)[number]["value"];
export type PoseKey = (typeof POSES)[number]["value"];
export const SCENARIO_KEYS = SCENARIOS.map((s) => s.value) as [ScenarioKey, ...ScenarioKey[]];
export const POSE_KEYS = POSES.map((p) => p.value) as [PoseKey, ...PoseKey[]];

export const MAX_PERSONAL_PHOTOS = 5;
export const MAX_ATTEMPTS = 3;
