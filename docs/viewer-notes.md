# Viewer: how it draws, and what it does not do yet

`renderView(workspace, key, options)` (packages/viewer) turns one resolved view into a standalone SVG, plus the
geometry of every node and edge. It is used by the VS Code preview, by `structurizr-dsl svg`, and is the base for the
SVG exporter.

## Layout

A small layered ("Sugiyama-style") layout, written from scratch (no dependencies), in `layout.ts`:

1. Levels are solved innermost first, so a boundary or deployment node takes its size from its children.
2. Within a level: cycles are broken, nodes get layers by longest path, edges spanning several layers get dummy nodes
   (which become waypoints), crossings are reduced with barycenter sweeps, and coordinates come from isotonic regression
   (nodes are pulled toward their neighbours without overlapping).
3. `autoLayout` direction (`tb bt lr rl`) is honoured; the separation numbers scale the gaps. The gap between layers
   also grows to fit the widest/tallest edge label, and with the number of parallel edges.
4. Container and component views draw the scope element as a dashed boundary around its children. Deployment views
   nest nodes, infrastructure nodes and instances as real containment.
5. Parallel edges between the same two boxes are fanned out. Labels try several positions along their edge and take
   the first that clears every box and every label already placed.

Tested with invariants (no overlapping siblings, children inside their parents, edges flow in the chosen direction) on
60 random graphs with nested boundaries in all four directions.

## Styling

Structurizr's defaults per tag (Person, Software System, Container, Component, deployment/infrastructure nodes, instances),
then the workspace's `styles` in declaration order for each tag an element carries, then `light` / `dark`. Terminology
(`person "Actor"`, `metadata round`) is applied. Structurizr's 450x300 boxes and 24px text are scaled by 0.5.

## Known limits

- **Shapes:** Box, RoundedBox, Circle, Ellipse, Hexagon, Diamond, Cylinder, Person and WebBrowser are drawn; Folder, Pipe,
  Robot, Window, Terminal, Shell, MobileDevice*, Component fall back to a box. `icon` is ignored.
- **Edges** are straight polylines through the layout's waypoints; `routing` (Orthogonal/Curved) and `jump` are ignored.
- **Labels** can still touch each other in very dense graphs (a self-relationship label is the usual culprit).
- **Themes** (`theme default`, remote themes) are not loaded; the built-in defaults stand in for the default theme.
- **No legend/key**, no animation playback (the steps are resolved but only the full view is drawn), image views show a
  placeholder naming their source.
- Text width is estimated from character counts (there is no font to measure with), so very long unbroken words may overflow.
- Deployment views draw every relationship the resolver put in the view; node-level implied relationships are not
  created for replicated instance relationships (see resolver-notes.md).
