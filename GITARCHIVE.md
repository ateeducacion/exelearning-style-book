# Exclusión del tema en el `gitarchive` del repo principal eXeLearning

Este tema vive en su propio repositorio (`exelearning-style-book`) y
**no se empaqueta dentro de la distribución principal de eXeLearning**.
Los usuarios lo instalan desde *Herramientas → Gestor de estilos →
Importar estilo* usando el ZIP publicado en cada release.

Para que el generador de `gitarchive` del repositorio principal omita
este tema si alguien decidiese empotrarlo como submódulo o copia local,
añadir estas reglas al `.gitattributes` del repositorio principal
([`exelearning/exelearning`](https://github.com/exelearning/exelearning)):

```gitattributes
# -------------------------------------------------------------
# Temas externos mantenidos en su propio repositorio —
# excluidos del archivo generado por `git archive`.
# -------------------------------------------------------------
public/files/perm/themes/base/book/**      export-ignore
public/files/perm/themes/base/book         export-ignore
```

Si el repo principal usa un archivo distinto (por ejemplo,
`.export-ignore` o un script `make/gitarchive.sh`), añadir el mismo
patrón allí.

## Por qué excluirlo

- El tema es **opcional** y tiene ciclo de release propio.
- Incluye la tipografía Literata (SIL OFL 1.1) y los iconos del estilo.
- Evita que `git archive` de la distribución principal aumente de
  tamaño innecesariamente con assets de estilo.

## Canal de instalación recomendado

```
Herramientas → Gestor de estilos → Importar estilo
   ↓
https://github.com/ateeducacion/exelearning-style-book/releases/latest
   ↓
exelearning-style-book-<versión>.zip
```

Elaborado por el **Área de Tecnología Educativa**.
