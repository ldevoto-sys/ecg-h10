# ECG H10

Grabación y análisis de ECG con una banda Polar H10 desde Chrome en Android. Uso personal, sin fines médicos: no diagnostica ni reemplaza a un médico ni a un examen.

## Qué hace
- Se conecta por Bluetooth (Web Bluetooth) y muestra el ECG en vivo (una derivación, 130 Hz).
- Graba sesiones en el teléfono (IndexedDB). Guarda checkpoints cada 30 s.
- Botón **Marcar síntoma** durante la grabación.
- Reconexión automática si se corta el Bluetooth; el hueco queda registrado y no se calculan RR a través de él.
- Análisis: picos R, FC, SDNN, RMSSD, pNN50, tacograma, Poincaré, ventanas de 30 latidos con mayor irregularidad (CV), latidos con RR >20 % distinto de la mediana de sus vecinos ("corto"/"largo"), FC y CV alrededor de cada síntoma marcado.
- Exporta CSV (señal y latidos), JSON e informe imprimible/PDF.
- Modo **Simulador** (señal sintética, marcada SIMULADA) para probar sin banda.

## Cómo abrirla en el teléfono
Web Bluetooth exige HTTPS o `localhost`. Opciones:
1. **PC + USB**: en el PC `python3 -m http.server 8000` en esta carpeta; en Chrome del PC abrir `chrome://inspect/#devices`, activar *Port forwarding* 8000 → `localhost:8000`, y abrir `http://localhost:8000` en Chrome del teléfono (depuración USB activa).
2. **Termux en el teléfono**: `pkg install python`, `python -m http.server 8000` en esta carpeta, abrir `http://localhost:8000`.
3. **GitHub Pages** (recomendada): `https://ldevoto-sys.github.io/ecg-h10/`. Settings → Pages → Deploy from a branch → `main` → `/ (root)`. El código no contiene datos de salud; las grabaciones quedan en el teléfono.

## Criterios de ritmo (provisionales, no diagnósticos)
El informe resume tres indicadores y una frase combinada:
1. **Irregularidad de intervalos**: CV de los RR en ventanas de 30 latidos (baja <0,10; alta >0,20).
2. **Patrón de los RR**: alternante (largo-corto) o al azar, según la fracción de cambios de signo de las diferencias sucesivas y la autocorrelación de lag 1.
3. **Ondas P**: coherencia de la ventana 300–40 ms antes del QRS entre latidos alineados en R (coherentes ≥0,70; incoherentes ≤0,40). Solo usa latidos con RR previo ≥500 ms. Con ruido alto (>30 µV RMS sobre 30 Hz) no se declara "incoherentes". Se muestra el latido promedio para revisarlo a ojo.

Evidencia usada para los umbrales (3 informes de 30 s de otro dispositivo, digitalizados desde imagen y pasados a 130 Hz; etiquetas de clasificación automática):

| Señal | CV | Patrón | Coherencia P |
|---|---|---|---|
| FA 30-jul | 0,31 | al azar | 0,29 |
| FA 13-ago | 0,31 | al azar | 0,28 |
| Latidos prematuros 1-sep | 0,24 | alternante | 0,76 |
| Tramo sinusal regular (1-sep, 9–30 s) | 0,02 | — | 0,91 |
| Sintético con P / sin P | 0,03 / 0,25 | — / al azar | 0,96 / 0,13 |

Sensibilidad al ruido (sintético con P de 120 µV): coherencia 0,96 con ruido de 15 µV, 0,87 con 30, 0,66 con 60, 0,45 con 100, 0,29 con 150. Con la H10 real puede variar; recalibrar con grabaciones propias.

Limitaciones: la ausencia de P no se puede medir con ritmo rápido (pocos latidos con RR ≥500 ms), un flutter también tiene ondas regulares, y los latidos prematuros repetidos bajan la coherencia (por eso se combina con el patrón de los RR). Las señales de referencia no se incluyen en el repo (datos personales).

## Pruebas
- `node test/dsp.test.js`: procesamiento (picos R, FC, latido prematuro, huecos, calidad, ruido).
- `NODE_PATH=$(npm root -g) node test/e2e.js`: Chromium real con banda simulada (protocolo PMD, reconexión, análisis, exportación).

## Estado de verificación
Verificado con señal sintética y banda simulada. **No verificado con una H10 real**: protocolo PMD (UUIDs, comando de inicio, formato de trama), detección de huecos por timestamp y umbrales de calidad. Los datos del protocolo provienen de la documentación pública del SDK de Polar y deben confirmarse con la banda.

## Límites
- Una sola derivación a 130 Hz: no sirve para medir PR, QT ni ST con fiabilidad, ni reemplaza un ECG de 12 derivaciones.
- Un ritmo irregular en los RR puede deberse a ruido, ectopias o arritmia; la app no puede distinguir ni confirmar fibrilación auricular (no evalúa ondas P de forma fiable).
- Umbrales de calidad (`DSP.CFG` en `dsp.js`) y del 20 % para latidos corto/largo son heurísticos, sin calibrar con datos reales.
- Si el sistema suspende Chrome o apaga la pantalla, la transmisión puede cortarse. Mantener la pantalla encendida (la app solicita wake lock).
