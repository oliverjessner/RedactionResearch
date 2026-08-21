class RedactionResearch < Formula
  desc "Find and review potentially incomplete PDF redactions locally"
  homepage "https://github.com/oliverjessner/RedactionResearch"
  url "https://registry.npmjs.org/redaction-research/-/redaction-research-0.1.0.tgz"
  sha256 "840c3df26465e864c1e5c9eeb7b54fdf42afefcb9c40d9e7ceaa7ab7c404a28a"
  license "ISC"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/redaction-research --version")
  end
end
