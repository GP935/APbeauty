# n8n — AP Beauty

## `comprobante-pago.json` — comprobante de pago por correo (BLOQUE 2)

Esqueleto de workflow. Al confirmarse un pago Mercado Pago `approved`, el
backend (`server/server.js` → `notificarComprobante`) hace **un POST** a este
workflow con la orden ya validada. n8n genera el comprobante y envía 2 correos:
al cliente y a la casilla interna.

### Contrato del POST (lo que manda el backend)

```json
{
  "order_id": "uuid",
  "customer_name": "string (nombre del titular de la tarjeta, puede venir vacío)",
  "customer_email": "string",
  "items": [{ "name": "Individuales · Icónica", "quantity": 1, "price_pen": 35 }],
  "total_pen": 55,
  "payment_id": "string (id de Mercado Pago)",
  "payment_date": "ISO 8601"
}
```

`price_pen` y `total_pen` van en **soles** (unidad mayor), no céntimos.

### Puesta en marcha

1. Importar `comprobante-pago.json` en n8n.
2. **Webhook node** → crear credencial *Header Auth*: nombre de header
   `Authorization`, valor `Bearer <TOKEN>`. El mismo `<TOKEN>` va en
   `N8N_WEBHOOK_TOKEN` del `.env` del backend.
3. Copiar la *Production URL* del webhook → ponerla en `N8N_WEBHOOK_URL` del
   `.env` del backend. **Debe ser accesible desde el VPS Hetzner** (n8n en
   `localhost:5678` del PC de Paul NO lo es — hace falta n8n con URL pública,
   túnel, o n8n en el propio VPS).
4. **emailSend nodes** → configurar credencial SMTP (Resend / SendGrid / Gmail /
   SMTP propio — pendiente decisión de Paul) y rellenar los `[PLACEHOLDER]`:
   remitente de marca, correo interno, canal de contacto.
5. Activar el workflow.

### Decisión pendiente de Paul

- **Formato del comprobante:** Opción A (email HTML, ya implementada) vs
  Opción B (adjuntar PDF: insertar un nodo *HTML to PDF* entre
  «Idempotencia + formato» y los «emailSend»).
- **Proveedor de email transaccional.**
- **Correo interno** para el registro de ventas.

### Idempotencia

Doble capa:
- **Backend:** `pedido.comprobanteEnviado` — `process-payment` y el webhook de
  MP no disparan el POST dos veces para el mismo pedido.
- **n8n:** el nodo *Idempotencia + formato* guarda los `payment_id` ya
  procesados en `staticData` y descarta duplicados (por si el backend reintenta
  tras un fallo de red).
