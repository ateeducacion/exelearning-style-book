# eXeLearning Libro

Estilo de eXeLearning para leer un recurso como un libro abierto sobre la mesa.
Cada página del recurso se corta en páginas de libro: dos a la vez en pantallas
anchas y una en el móvil, sin desplazamiento vertical. El ejemplo incluye las 11
páginas de **El ciclo del agua**, con actividades de ordenar las fases y
verdadero/falso.

[Descargar estilo Libro](https://github.com/ateeducacion/exelearning-style-book/raw/refs/heads/main/content/resources/book.zip) · [Abrir el ejemplo en eXeLearning](https://static.exelearning.dev/?url=https://github-proxy.exelearning.dev/?repo=ateeducacion/exelearning-style-book&branch=main)

Importa `book.zip` desde el gestor de estilos de eXeLearning 4.
La raíz del repositorio es el ejemplo ELPX descomprimido; `theme/` contiene el estilo.

## Lectura

- **Esquinas inferiores**: pasan página. Al pasar el ratón se levantan; al pulsar,
  la hoja se dobla desde la esquina, cruza el lomo y se posa al otro lado.
  En la última página de una sección se pasa a la siguiente; hacia atrás se abre
  la sección anterior por su última página.
- **← y →** (también Re Pág y Av Pág) pasan página fuera de los controles de las
  actividades. En el móvil también se puede deslizar el dedo.
- **Cinta de marcapáginas**: abre el índice, con el buscador y la licencia.
  Escape lo cierra.
- Los cantos de las hojas a los lados crecen o menguan según lo leído, y el pie
  de cada página lleva su número (sección·página).
- Una sección que acaba en la página izquierda cierra la derecha con un adorno y
  el enlace a la siguiente.

Las actividades nunca se parten entre páginas; si una no cabe en una página, se
desplaza dentro de ella. El paso de página usa transiciones de vista: en los
navegadores que no las tienen, o con «reducir movimiento», la página cambia sin
animación. Sin JavaScript, o al imprimir, el contenido se lee como una página normal.

## Vista previa y paquetes

```sh
python3 -m http.server 1314 --bind 127.0.0.1
python3 scripts/package.py
python3 scripts/check.py
```

Abre <http://localhost:1314/>. Los paquetes quedan en `dist/book.zip` y
`dist/ciclo-del-agua.elpx`; el ZIP del estilo también se copia a `content/resources/`
para descargarlo desde el ejemplo.

Las comprobaciones de navegador usan Chrome y el Playwright que ya incluye eXeLearning:

```sh
NODE_PATH=/ruta/a/exelearning/node_modules node scripts/check-browser.cjs
```

Recorren el libro entero con las esquinas, la vuelta a la última página de la
sección anterior, el teclado, el índice, las actividades y los anchos de móvil.
Para regenerar la miniatura, añade `BOOK_SCREENSHOT=theme/screenshot.png` al comando.

## Mantenimiento y publicación

La estructura de publicación procede de `exelearning-style-pocket`: Actions,
`.gitignore`, `.gitattributes`, licencia y notas de `git archive`.

- `python3 scripts/build_water_cycle.py`: reconstruye el ejemplo ELPX y el estilo
  desde los archivos actuales.
- Para regenerar las páginas HTML del ejemplo, exporta el ELPX con el CLI de
  eXeLearning desde su propio directorio:
  `bun dist/cli.js elp:export /ruta/a/dist/ciclo-del-agua.elpx /tmp/libro html5`.

El workflow **Release** se ejecuta manualmente desde Actions o al subir una etiqueta
`v*`. Comprueba el ejemplo y genera `exelearning-style-book-<versión>.zip`,
`book.zip` y `ciclo-del-agua.elpx`. En una ejecución manual se guardan como
artefactos; con una etiqueta se adjuntan a la release.

## Créditos y licencias

[Licencia general CC0](LICENSE), salvo los archivos que indican otra licencia.

El estilo deriva del estilo Default de eXeLearning (Ignacio Gros, exelearning.net)
y conserva su licencia CC BY-SA 4.0, igual que los iconos de iDevices de Francisco
Javier Pulido Cuadrado. Literata, de The Literata Project Authors, bajo
[SIL OFL 1.1](theme/fonts/OFL.txt). Unidad didáctica e ilustraciones reutilizadas
del estilo Spectrum 128K del Área de Tecnología Educativa del Gobierno de Canarias,
bajo CC0 1.0. Los archivos de eXeLearning y sus bibliotecas conservan sus licencias
originales.
