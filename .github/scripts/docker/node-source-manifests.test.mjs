import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(
	readFileSync(new URL('../../workflows/build-node-pc-image.yml', import.meta.url), 'utf8'),
);
const manifestStep = workflow.jobs['create-multi-arch-manifest'].steps.find(
	(step) => step.name === 'Create multi-arch manifests',
);
const variants = [
	{ target: 'node-pc', repo: 'node-pc', version: '26.13.0' },
	{ target: 'node-patched-24', repo: 'node-patched', version: '24.22.3' },
	{ target: 'node-patched-26', repo: 'node-patched', version: '26.13.0' },
];

function render(template, values) {
	return template.replace(/\$\{\{ (.+?) \}\}/g, (_, key) => {
		assert.ok(Object.hasOwn(values, key), `Unknown workflow expression: ${key}`);
		return values[key];
	});
}

function context(image, overrides = {}) {
	const values = {
		'secrets.DOCKER_USERNAME': 'n8nio',
		'github.repository_owner': 'n8n-io',
		'matrix.image.repo': image.repo,
		"needs.prepare.outputs[format('node_version_{0}', matrix.image.key)]": image.version,
		'github.sha': 'commit',
		'github.run_id': '100',
		'github.run_attempt': '2',
		...overrides,
	};
	values['env.REPO'] = render(workflow.jobs.build.env.REPO, values);
	values['env.NODE_VERSION'] = render(workflow.jobs.build.env.NODE_VERSION, values);
	values['env.STAGING_TAG'] = render(workflow.env?.STAGING_TAG ?? '', values);
	return values;
}

function buildImages(values) {
	return workflow.jobs.build.steps
		.filter((step) => step.with?.tags)
		.flatMap((step) =>
			['amd64', 'arm64'].flatMap((arch) =>
				render(step.with.tags, { ...values, 'matrix.platform.arch': arch })
					.trim()
					.split('\n')
					.map((tag) => ({ tag, arch, stage: step.with.target })),
			),
		);
}

function publish(
	image,
	{ missingImage = '', previousExecution, failedBuild, skipBuild = false } = {},
) {
	const values = context(image);
	const images = new Map();
	if (previousExecution) {
		for (const { tag } of buildImages(context(image, previousExecution))) {
			images.set(tag, 'previous');
		}
	}
	for (const { tag, arch, stage } of skipBuild ? [] : buildImages(values)) {
		if (failedBuild?.arch === arch && failedBuild.stage === stage) continue;
		images.set(tag, 'current');
	}
	images.delete(missingImage);

	return spawnSync(
		'bash',
		[
			'-e',
			'-o',
			'pipefail',
			'-c',
			`
generation() {
  while read -r tag generation; do
    if [ "$tag" = "$1" ]; then echo "$generation"; return 0; fi
  done <<< "$IMAGES"
  return 1
}
docker() {
  if [ "$3" = inspect ]; then
    generation "$4"
  elif [ "$3" = create ]; then
    for image in "\${@:6}"; do
      source_generation=$(generation "$image") || return 1
      echo "source $image $source_generation"
    done
    echo "create $5"
  else
    return 1
  fi
}
${render(manifestStep.run, values)}`,
		],
		{
			encoding: 'utf8',
			env: {
				...process.env,
				NODE_VERSION: render(manifestStep.env.NODE_VERSION, values),
				STAGING_TAG: values['env.STAGING_TAG'],
				IMAGES: [...images].map(([tag, generation]) => `${tag} ${generation}`).join('\n'),
			},
		},
	);
}

describe('Node source image manifests', () => {
	for (const image of variants) {
		describe(image.target, () => {
			const repositories = [`n8nio/${image.repo}`, `ghcr.io/n8n-io/${image.repo}`];
			for (const repository of repositories) {
				for (const stage of ['', '-dev']) {
					for (const arch of ['amd64', 'arm64']) {
						const missingImage = `${repository}:${image.version}-commit-100-2${stage}-${arch}`;
						it(`keeps all tags unchanged when ${missingImage} is missing`, () => {
							const result = publish(image, { missingImage });
							assert.notEqual(result.status, 0, result.stderr);
							assert.doesNotMatch(result.stdout, /^create /m);
							assert.ok(result.stderr.includes(missingImage), result.stderr);
							assert.match(result.stderr, /Re-run all jobs/);
						});
					}
				}
			}

			for (const [name, previousExecution] of [
				['run', { 'github.run_id': '99' }],
				['attempt', { 'github.run_attempt': '1' }],
			]) {
				for (const stage of ['runtime', 'dev']) {
					for (const arch of ['amd64', 'arm64']) {
						it(`keeps all tags unchanged after a failed ${stage} ${arch} rebuild with prior ${name} images`, () => {
							const result = publish(image, { previousExecution, failedBuild: { stage, arch } });
							assert.notEqual(result.status, 0, result.stderr);
							assert.doesNotMatch(result.stdout, /^create /m);
						});
					}
				}
			}

			it('requires a full rerun when only the manifest job is retried', () => {
				const result = publish(image, {
					previousExecution: { 'github.run_attempt': '1' },
					skipBuild: true,
				});
				assert.notEqual(result.status, 0, result.stderr);
				assert.doesNotMatch(result.stdout, /^create /m);
				assert.match(result.stderr, /Re-run all jobs/);
			});

			it('publishes runtime and dev tags in both registries after a full rebuild', () => {
				const result = publish(image, { previousExecution: { 'github.run_attempt': '1' } });
				assert.equal(result.status, 0, result.stderr);
				const sources = result.stdout.split('\n').filter((line) => line.startsWith('source '));
				const expectedSources = repositories.flatMap((repository) =>
					['', '-dev'].flatMap((stage) =>
						['amd64', 'arm64'].flatMap((arch) =>
							Array(2).fill(`${repository}:${image.version}-commit-100-2${stage}-${arch} current`),
						),
					),
				);
				assert.deepEqual(
					sources.map((source) => source.slice('source '.length)).sort(),
					expectedSources.sort(),
				);
				const createdTags = result.stdout
					.split('\n')
					.filter((line) => line.startsWith('create '))
					.map((line) => line.slice('create '.length));
				const expectedTags = repositories.flatMap((repository) =>
					['', '-dev'].flatMap((stage) => [
						`${repository}:${image.version}${stage}`,
						`${repository}:${image.version}-commit${stage}`,
					]),
				);
				assert.deepEqual(createdTags.sort(), expectedTags.sort());
			});
		});
	}
});
