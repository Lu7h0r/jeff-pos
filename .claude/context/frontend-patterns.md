# Frontend Patterns — FinOpenPOS Jeff

## Stack UI

Next.js 15 App Router · React 19 · shadcn/ui · Tailwind CSS · tRPC client

## Patrón de Componente de Admin

```tsx
'use client';
import { trpc } from '@/lib/trpc/client';
import { useLocationContext } from '@/hooks/use-location-context'; // si existe

export function MyFeature() {
  const { data, isLoading } = trpc.myRouter.list.useQuery({ locationId });
  const mutation = trpc.myRouter.create.useMutation({
    onSuccess: () => utils.myRouter.list.invalidate(),
  });
  // ...
}
```

## Selector de Sede

`<LocationSelector />` en `src/components/location-selector.tsx`. Escribe cookie `jeff_active_location`. Los routers leen ese valor como `locationIdHint`. Al cambiar sede, refetch automático de queries que dependen de locationId.

## shadcn/ui Components

Usar siempre los componentes de `src/components/ui/`. No reinventar botones, tablas, diálogos, inputs. Agregar nuevos shadcn components con `bunx shadcn@latest add <component>`.

Componentes disponibles: `Button`, `Card`, `Table`, `DataTable`, `Dialog`, `Input`, `Label`, `Select`, `Combobox`, `Badge`, `Popover`, `Command`, `Pagination`, `SearchFilter`, `Skeleton`, `Tooltip`, `Chart`, `DropdownMenu`.

## Tablas de Datos

Usar `DataTable` de `src/components/ui/data-table.tsx` con TanStack Table. No hacer tablas HTML manuales.

## Formularios

- Validar en cliente con Zod + React Hook Form (si ya se usa en el componente adyacente)
- Mostrar errores de tRPC en el UI: `error.data?.zodError` o `error.message`
- No deshabilitar botón de submit mientras no haya cambios — esperar el resultado de la mutación

## Formateo de Moneda

```typescript
import { formatCOP } from '@/lib/utils';
// → "$ 12.500" o similar
```

Nunca hardcodear `$` ni `USD` en UI de producto.

## Imágenes de Productos

- `image_url`: URL principal, mostrar en lista
- `image_urls`: JSON array de URLs, mostrar galería en detalle
- Fallback a placeholder si URL falla (`onError`)

## Convenciones de UI

- Texto del producto en español neutro (no rioplatense)
- Sin emoji decorativo en UI de producto
- Loading states con `<Skeleton>` mientras cargan queries
- Confirmación de borrado/anulación siempre con `<Dialog>` de confirmación (`delete-confirmation-dialog.tsx`)

## Auth Guard

Rutas bajo `/admin/*` están protegidas por `src/lib/auth-guard.ts` que verifica cookie `sanctum`. No duplicar la lógica de auth en componentes individuales.

## Server Components vs Client Components

- Páginas de admin: mayoría Client Components (`'use client'`) por el uso de tRPC client-side
- Layout (`admin/layout.tsx`): Server Component — no leer cookies de sesión acá, delegar a auth-guard
- Mutaciones y queries tRPC: siempre desde Client Components
