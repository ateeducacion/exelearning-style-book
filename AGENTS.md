# Libro

- `theme/` es la fuente del estilo; la raíz es el ejemplo ELPX descomprimido.
- No modificar eXeLearning ni los otros repositorios de estilos para arreglar Libro.
- `style.js` añade `html.book-paged` en el `<head>`; todo el modo libro cuelga de esa clase
  y de `body.exe-web-site`. Sin JavaScript o al imprimir, el contenido es una página normal.
- Las páginas son columnas CSS de `main.page`: el relleno lateral suma lo mismo que el hueco
  entre columnas, así que una doble página mide exactamente `main.clientWidth`.
- Cabeceras, folios y el cierre de sección van dentro de `main` (giran con la hoja);
  esquinas, cinta e índice van fuera.
- El paso de página es una transición de vista (`book-page` y `book-sheet-back`); `style.js`
  calcula el pliegue. No clonar ni reescribir iDevices.
- Un elemento solo cabe en una transición (dos imágenes). El reverso real de la hoja sale de
  combinar una del documento (imagen fija de `main` con dos dobles páginas, `html.book-wide`)
  con otra acotada al libro (`book-spread`): ver `openFold`. Sin ella, `openRoll` (dos imágenes).
- La geometría (`foldTo` y compañía) es pura y se prueba en `scripts/check-turn.cjs`; los
  eventos de puntero no dibujan, lo hace `tick` una vez por fotograma.
- El botón «Edit with eXeLearning» es solo del ejemplo publicado: vive en `edit-in-exelearning.js`
  (raíz) y `package.py` lo añade al HTML. Nunca en `theme/`, o saldría en los recursos exportados.
- `python3 scripts/package.py` reconstruye ambos paquetes, el manifiesto de descarga y el enlace anterior.
- Validar con `python3 scripts/check.py` y `NODE_PATH=/ruta/a/exelearning/node_modules node scripts/check-browser.cjs`.
- Para regenerar el HTML del ejemplo, usar el CLI de eXeLearning desde su propio directorio:
  `bun dist/cli.js elp:export /ruta/al/ciclo-del-agua.elpx /tmp/libro html5`.
- El estilo es CC BY-SA 4.0 (deriva de Default); Literata conserva OFL; el material didáctico es CC0.
