import { defineConfig } from "eslint/config";
import typescriptEslint from "typescript-eslint";

export default defineConfig({
	files: ["**/*.ts"],
	extends: typescriptEslint.configs.recommended,
	rules: {
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		"@typescript-eslint/naming-convention": [
			"warn",
			{
				selector: "import",
				format: ["camelCase", "PascalCase"],
			},
		],
		curly: "warn",
		// `== null` is the deliberate idiom for "null or undefined"; forcing `===`
		// there would narrow the check and change behaviour. Matches a2a's config.
		eqeqeq: ["warn", "always", { "null": "ignore" }],
		"no-throw-literal": "warn",
		semi: "warn",
	},
});
