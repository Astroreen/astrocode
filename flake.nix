{
  description = "Astrocode — model-aware opencode plugin (agent personas, fallback, slash commands)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        # Minimal runtime output: only what the plugin reads from disk at
        # startup (agents/*.md, skills/builtin/**/SKILL.md, src/**) plus the
        # package/tsconfig metadata it walks up to find. Deliberately
        # excludes test/, docs/, spike/, .opencode/, .sisyphus/ — dev-only
        # cruft that shouldn't end up copied into every consuming host's
        # ~/.config/opencode/plugins/.
        packages.default = pkgs.stdenvNoCC.mkDerivation {
          pname = "astrocode";
          version = "0.0.1";
          src = ./.;

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r agents skills src package.json tsconfig.json README.md $out/
            runHook postInstall
          '';

          meta = {
            description = "Model-aware opencode plugin: agent personas, fallback, slash commands";
            homepage = "https://github.com/Astroreen/astrocode";
          };
        };

        # `nix flake check` gate: ensures the packaging step itself doesn't
        # break (missing dirs, typos in installPhase) before any consuming
        # host's `home switch` would pick up a broken commit. Does not run
        # `bun test` — that needs network-fetched node_modules, which isn't
        # available in the Nix build sandbox without extra tooling
        # (bun2nix or a pre-fetched FOD lockfile derivation); left as a
        # manual `bun test` step in CI/devShell instead.
        checks.build = self.packages.${system}.default;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.nodejs
          ];
          shellHook = ''
            echo "astrocode dev shell — run: bun install && bun test"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
