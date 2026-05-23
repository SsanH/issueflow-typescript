module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist/**', 'coverage/**'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',

    // D6b: prevent the silent audit-bypass at lint time, not just code review.
    // TypeORM subscribers (used by AuditSubscriber per D6) DO NOT fire for:
    //   - Repository#update(id, partial)
    //   - Repository#delete(id) / Repository#softDelete(id)
    //   - QueryBuilder .update() / .delete() / .softDelete()
    // Always use repo.save(entity) / repo.softRemove(entity) / repo.recover(entity)
    // for audited entities. If you must call .update/.delete on a non-audited
    // entity (e.g. RevokedToken cleanup), add an inline disable WITH a justification:
    //   // eslint-disable-next-line no-restricted-syntax -- RevokedToken is not audited
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(update|delete|softDelete)$/]",
        message:
          'Audited entities must be written via repo.save() / softRemove() / recover() so the AuditSubscriber fires (D6a). If this call is genuinely not on a Repository/QueryBuilder for an audited entity, disable on this line with a justification.',
      },
    ],
  },
};
