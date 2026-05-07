# SDD — Servicios Tattoo/Piercing + POS + Inventario + WhatsApp

Estado: `draft`  
Proyecto: `jeff-pos / FinOpenPOS`  
Última actualización: 2026-05-07

---

## 1) Objetivo

Implementar un flujo completo y trazable para servicios (tattoo/piercing) que soporte:

- precio pactado total,
- abonos parciales,
- sesiones,
- comisión por artista,
- consumo automático de insumos (tintas/agujas/etc),
- fotos por servicio/sesión,
- envío posterior por WhatsApp (vía webhook/n8n),
- POS con UX visual y operable para caja.

---

## 2) Requerimientos

## 2.1 Funcionales

- [ ] **RF-01** Servicios como entidad comercial (no producto): total pactado, saldo, estado.
- [ ] **RF-02** Abonos múltiples por servicio con saldo pendiente actualizado.
- [ ] **RF-03** Sesiones 1..N por servicio con artista, fecha, notas y estado.
- [ ] **RF-04** Comisión configurable y trazable (devengada/pagada).
- [ ] **RF-05** Descuento automático de insumos por plantilla de consumo.
- [ ] **RF-06** Permisos por rol/sede (cashier sin ajustes manuales de inventario).
- [ ] **RF-07** Fotos por servicio/sesión (referencia, proceso, resultado).
- [ ] **RF-08** Datos cliente + WhatsApp + consentimiento para envíos.
- [ ] **RF-09** Emisión de eventos/outbox para integración webhook/n8n.
- [ ] **RF-10** POS visual con flujo guiado para abonos y servicios.

## 2.2 No funcionales

- [ ] **RNF-01** Atomicidad en caja + servicio + inventario según caso.
- [ ] **RNF-02** Auditoría completa por usuario/sede/fecha.
- [ ] **RNF-03** Seguridad de permisos (backend-first con guards).
- [ ] **RNF-04** Escalabilidad de integración externa (outbox/event-driven).
- [ ] **RNF-05** UX apta para adopción operativa (onboarding + claridad visual).

---

## 3) Fases (ejecución incremental)

## Fase 1 — Core Servicios + Pagos + Permisos

Objetivo: vender servicios con abonos de forma operativa.

- [ ] Crear modelo de servicio-proyecto (precio total, estado, saldo, cliente, artista principal).
- [ ] Registrar abonos parciales desde POS/caja.
- [ ] Exponer total pactado / abonado / pendiente.
- [ ] Asegurar guards de roles/sede para cashier/manager/owner.

**CDA Fase 1**

- [ ] Se puede crear servicio con total pactado.
- [ ] Se puede cobrar abono parcial y queda en caja.
- [ ] Saldo pendiente se recalcula correctamente.
- [ ] Cashier NO puede ajustar inventario manual.

## Fase 2 — Sesiones + Comisión

Objetivo: soportar tattoos grandes multi-sesión.

- [ ] Modelo de sesiones (fecha, artista, notas, avance, estado).
- [ ] Política de comisión configurable (sobre cobrado o sobre completado).
- [ ] Liquidación básica y estado de pago por artista.

**CDA Fase 2**

- [ ] Un servicio permite múltiples sesiones.
- [ ] Cada sesión queda auditada.
- [ ] Comisión se calcula según política definida.

## Fase 3 — Inventario por consumo automático

Objetivo: trazabilidad real de tintas/agujas e insumos.

- [ ] Plantillas de consumo por tipo/tamaño/categoría (BOM liviano).
- [ ] Descuento automático al confirmar sesión (o trigger acordado).
- [ ] Bloqueo por stock insuficiente con mensaje claro.
- [ ] Ajuste manual solo manager/owner con motivo obligatorio.

**CDA Fase 3**

- [ ] Confirmar sesión descuenta insumos.
- [ ] Sin stock suficiente, la operación se bloquea.
- [ ] Todo movimiento queda trazable por servicio/sesión.

## Fase 4 — Fotos + Cliente + WhatsApp (Integración)

Objetivo: post-servicio y seguimiento automatizable.

- [ ] Adjuntar fotos por servicio/sesión.
- [ ] Guardar WhatsApp y consentimiento explícito.
- [ ] Outbox/eventos: `media_uploaded`, `whatsapp_dispatch_requested`, etc.
- [ ] Integración con n8n/webhook (desacoplada del core).

**CDA Fase 4**

- [ ] Se pueden subir y listar fotos por sesión.
- [ ] Sin consentimiento no se dispara envío.
- [ ] El sistema registra intentos y estado de envío.

## Fase 5 — POS UI/UX Visual

Objetivo: sacar sensación “excel” y acelerar caja.

- [ ] Catálogo visual (cards, búsqueda instantánea, recientes).
- [ ] Carrito lateral fijo con resumen financiero claro.
- [ ] Bloque visible: total pactado / abonado / pendiente / comisión estimada.
- [ ] Quick actions: abono, saldo, descuento autorizado.
- [ ] Onboarding en dashboard y ayudas contextuales.

**CDA Fase 5**

- [ ] Registrar abono en <= 3 interacciones desde POS.
- [ ] Cajera entiende flujo sin capacitación técnica extensa.
- [ ] Métrica de error operativo baja en pruebas de usuario.

---

## 4) Definiciones de negocio pendientes (gate)

Antes de implementar Fase 2/3 cerrar:

- [ ] Comisión: sobre cobrado vs sobre completado.
- [ ] Cancelación/no-show: regla de abono (retiene/devuelve/reprograma).
- [ ] Piercing: joya incluida o separada como producto.
- [ ] Momento exacto del descuento de insumos.
- [ ] Texto y almacenamiento de consentimiento WhatsApp/fotos.

---

## 5) Estrategia de tests (obligatorio)

## 5.1 Unit

- [ ] Cálculo de saldo pendiente.
- [ ] Cálculo de comisión por política.
- [ ] Validación de estados/transiciones de servicio/sesión.
- [ ] Validación de permisos por rol.

## 5.2 Integration (tRPC + DB)

- [ ] Crear servicio + abono + saldo.
- [ ] Registrar sesión + consumir insumos.
- [ ] Rechazar operación con stock insuficiente.
- [ ] Rechazar ajustes de inventario por cashier.
- [ ] Transferencia entre sedes (manager/owner).

## 5.3 Consistencia transaccional

- [ ] Atomicidad cobro + movimiento de caja.
- [ ] Atomicidad sesión + movimientos de inventario.
- [ ] Idempotencia de eventos outbox.

## 5.4 E2E (Playwright)

- [ ] Abrir caja → registrar abono → verificar saldo.
- [ ] Servicio multi-sesión con artista y notas.
- [ ] Cierre de servicio con saldo en cero.
- [ ] Upload de fotos + creación de evento de envío.

## 5.5 Regression mínima pre-deploy

- [ ] `bun run lint`
- [ ] `bun test`
- [ ] Smoke E2E: login, caja, POS, productos, servicio básico.

---

## 6) Backlog inicial (sprints)

## Sprint 1

- [ ] Fase 1 completa + unit/integration tests core.

## Sprint 2

- [ ] Fase 2 completa + arranque de Fase 3.

## Sprint 3

- [ ] Fase 3 completa + Fase 5 MVP UX.

## Sprint 4

- [ ] Fase 4 + hardening + E2E completos.

---

## 7) Eventos sugeridos (tracking)

- [ ] `service_created`
- [ ] `service_payment_recorded`
- [ ] `service_session_created`
- [ ] `service_session_completed`
- [ ] `inventory_consumed_for_service`
- [ ] `service_commission_calculated`
- [ ] `service_media_uploaded`
- [ ] `whatsapp_dispatch_requested`
- [ ] `whatsapp_dispatch_result`

---

## 8) Notas de implementación

- Mantener separación estricta entre venta de producto e ingreso por servicio.
- El ajuste manual de inventario debe ser excepcional y auditado.
- Integración WhatsApp debe ser asíncrona (outbox + worker/n8n), no bloqueante.
