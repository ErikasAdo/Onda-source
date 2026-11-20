# Getting Onda on F-Droid (phone-only guide)

The private repo builds your signed APKs. A second, PUBLIC repo (ErikasAdo/Onda-source) holds only the source, and F-Droid reads that one.

1. Make an empty PUBLIC repo called `Onda-source` (no README).
2. Make a fine-grained token (Settings > Developer settings > Personal access tokens > Fine-grained): only `Onda-source`, permission "Contents: Read and write". Save it in the private repo as a secret named `PUBLISH_PAT`.
3. Actions > "Publish source to the public repo" > Run workflow (version 1.0.0, code 1, tag v1.0.0).
4. Open `fdroid/com.erikasado.onda.yml` and submit it to F-Droid (RFP issue or fdroiddata merge request).

F-Droid signs the app with its own key unless reproducible builds are set up, so the F-Droid copy and the Uptodown copy cannot update each other.
