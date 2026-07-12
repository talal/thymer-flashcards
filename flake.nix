{
  description = "Development shell for Thymer Flashcards Plugin";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz";

  outputs = {nixpkgs, ...}: let
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
  in {
    devShells.x86_64-linux.default = pkgs.mkShell {
      packages = with pkgs; [
        nodejs
        typescript-language-server
      ];

      shellHook = ''
        # Make sure node bin directory is in PATH
        export PATH="$PWD/frontend/node_modules/.bin:$PATH"
      '';
    };
  };
}
