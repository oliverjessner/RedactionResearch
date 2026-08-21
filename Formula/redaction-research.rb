class RedactionResearch < Formula
  desc "Find and review potentially incomplete PDF redactions locally"
  homepage "https://github.com/oliverjessner/RedactionResearch"
  url "https://registry.npmjs.org/redaction-research/-/redaction-research-0.1.1.tgz"
  sha256 "ff23cbbe6c26cedd8a94d156696320a002ac21ac8ac2a88c4efa101dc6ee8f5a"
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
