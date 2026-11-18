import { Home, ScanFace, Shirt, ShoppingBag, Sparkles, UserRound, type LucideIcon } from "lucide-react";

export interface NavItem { href: string; label: string; icon: LucideIcon }

/** Solo rutas que existen. Cada fase añade aquí su sección cuando está implementada. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Inicio", icon: Home },
  { href: "/wardrobe", label: "Armario", icon: Shirt },
  { href: "/stylist", label: "Estilista", icon: Sparkles },
  { href: "/try-on", label: "Probador", icon: ScanFace },
  { href: "/shopping", label: "Completa", icon: ShoppingBag },
  { href: "/profile", label: "Perfil", icon: UserRound },
];
