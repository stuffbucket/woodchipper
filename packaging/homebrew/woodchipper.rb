# frozen_string_literal: true

# Homebrew formula template for woodchipper.
#
# Rendered by `node scripts/render-homebrew-formula.mjs --version X.Y.Z --sums SHA256SUMS`
# during release assembly and synced into `stuffbucket/homebrew-tap` (`Formula/woodchipper.rb`).
# Do not commit real versions or archive digests to this template.

class Woodchipper < Formula
  desc "Reverse-engineering Pi agent harness, skill pack, playbooks, and REA/GLiNER appliance"
  homepage "https://github.com/stuffbucket/woodchipper"
  url "https://github.com/stuffbucket/woodchipper/releases/download/vPLACEHOLDER_VERSION/woodchipper-vPLACEHOLDER_VERSION.tar.gz"
  version "PLACEHOLDER_VERSION"
  sha256 "PLACEHOLDER_SHA256"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  depends_on "node"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/woodchipper.mjs" => "woodchipper"
    bin.install_symlink libexec/"scripts/woodchipper-ctl.mjs" => "woodchipper-ctl"
  end

  def caveats
    <<~EOS
      By default, Woodchipper writes per-target workspaces, TRIAGE_MAP.md, and REPORT.md to:
        ~/woodchipper/workspaces/<workspace>/
      (or ./woodchipper/workspaces/<workspace>/ if ./woodchipper already exists in your current directory).
    EOS
  end

  test do
    output = shell_output("#{bin}/woodchipper-ctl peers --json")
    assert_match "[", output
  end
end
